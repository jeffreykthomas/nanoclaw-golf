/**
 * HTTP-only Coach API entry point for NanoClaw.
 *
 * Starts a plain Node.js HTTP server with a single route:
 *   POST /v1/coach/respond
 *
 * No channels, no message loop, no IPC watcher, no scheduler.
 * Only the "app" transport is accepted.
 */
import http from 'http';
import fs from 'fs';
import { z } from 'zod';

import {
  APP_PORT,
  ASSISTANT_NAME,
  CLAW_SIBLING_TOKEN,
  COACH_FIRST_RESULT_TIMEOUT,
  ENABLE_COACH_AGENT,
} from './config.js';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import {
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { initDatabase, getSession, setSession } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { escapeXml, formatOutbound } from './router.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// --- Request schema ---

const CoachRequestSchema = z.object({
  requestId: z.string(),
  transport: z.string(),
  userId: z.number(),
  coachSessionId: z.number(),
  phase: z.enum(['onboarding', 'pre_round', 'during_round', 'post_round']),
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional().default({}),
});

type CoachRequest = z.infer<typeof CoachRequestSchema>;

// --- Helpers ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1_048_576; // 1MB
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function buildPrompt(req: CoachRequest): string {
  const contextXml =
    Object.keys(req.context).length > 0
      ? `\n<context>${escapeXml(JSON.stringify(req.context))}</context>`
      : '';

  return [
    `<coach-request phase="${escapeXml(req.phase)}" userId="${req.userId}">`,
    `<message>${escapeXml(req.message)}</message>`,
    contextXml,
    `</coach-request>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function getCoachGroup(coachSessionId: number): RegisteredGroup {
  const folder = `coach-${coachSessionId}`;
  // Ensure the group folder exists
  const groupDir = resolveGroupFolderPath(folder);
  fs.mkdirSync(groupDir, { recursive: true });

  return {
    name: `Coach Session ${coachSessionId}`,
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };
}

// --- Request handler ---

async function handleCoachRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${CLAW_SIBLING_TOKEN}`) {
    jsonResponse(res, 401, { error: 'unauthorized' });
    return;
  }

  // Parse body
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    jsonResponse(res, 400, { error: 'invalid_json' });
    return;
  }

  // Validate schema
  const parsed = CoachRequestSchema.safeParse(body);
  if (!parsed.success) {
    jsonResponse(res, 400, {
      error: 'validation_error',
      details: parsed.error.issues,
    });
    return;
  }
  const coachReq = parsed.data;

  // Transport check
  if (coachReq.transport !== 'app') {
    jsonResponse(res, 400, { error: 'unsupported_transport' });
    return;
  }

  const reqLogger = logger.child({ requestId: coachReq.requestId });
  reqLogger.info(
    {
      userId: coachReq.userId,
      coachSessionId: coachReq.coachSessionId,
      phase: coachReq.phase,
    },
    'Coach request received',
  );

  // Build group and prompt
  const group = getCoachGroup(coachReq.coachSessionId);
  const sessionId = getSession(group.folder);
  const prompt = buildPrompt(coachReq);

  // Collect streamed output
  const outputChunks: string[] = [];
  let newSessionId: string | undefined;
  let firstResultResolved = false;
  let resolveFirstResult:
    | ((value: { text: string; newSessionId?: string }) => void)
    | null = null;
  const firstResultPromise = new Promise<{
    text: string;
    newSessionId?: string;
  }>((resolve) => {
    resolveFirstResult = resolve;
  });

  try {
    const outputPromise = runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid: `app:coach-${coachReq.coachSessionId}`,
        isMain: false,
        assistantName: ASSISTANT_NAME,
      },
      (_proc, _containerName) => {
        // No queue registration needed for synchronous HTTP
      },
      async (streamOutput: ContainerOutput) => {
        if (streamOutput.newSessionId) {
          newSessionId = streamOutput.newSessionId;
          setSession(group.folder, streamOutput.newSessionId);
        }
        if (streamOutput.result) {
          const raw =
            typeof streamOutput.result === 'string'
              ? streamOutput.result
              : JSON.stringify(streamOutput.result);
          const text = formatOutbound(raw);
          if (text) {
            outputChunks.push(text);
            if (!firstResultResolved && resolveFirstResult) {
              firstResultResolved = true;
              resolveFirstResult({
                text: outputChunks.join('\n\n'),
                newSessionId,
              });
            }
          }
        }
      },
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('first_result_timeout')),
        COACH_FIRST_RESULT_TIMEOUT,
      ).unref();
    });

    const firstResult = await Promise.race([
      firstResultPromise,
      timeoutPromise,
    ]);

    if (firstResult.newSessionId) {
      setSession(group.folder, firstResult.newSessionId);
    }

    // Keep waiting in background for container completion/logging.
    outputPromise.catch((err) => {
      reqLogger.warn({ err }, 'Container promise rejected after response');
    });

    const combinedText = firstResult.text;
    reqLogger.info(
      { responseLength: combinedText.length },
      'Coach response sent',
    );
    jsonResponse(res, 200, { text: combinedText });
  } catch (err) {
    reqLogger.error({ err }, 'Unexpected error');
    jsonResponse(res, 500, { error: 'internal_error' });
  }
}

// --- Server ---

function startServer(): void {
  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      jsonResponse(res, 200, { status: 'ok' });
      return;
    }

    // Coach endpoint
    if (req.method === 'POST' && req.url === '/v1/coach/respond') {
      await handleCoachRequest(req, res);
      return;
    }

    jsonResponse(res, 404, { error: 'not_found' });
  });

  server.listen(APP_PORT, () => {
    logger.info({ port: APP_PORT }, 'Coach API server listening');
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    server.close(() => process.exit(0));
    // Force exit after 10s if connections don't close
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// --- Main ---

function main(): void {
  if (!ENABLE_COACH_AGENT) {
    logger.fatal('ENABLE_COACH_AGENT is not set to true. Exiting.');
    process.exit(1);
  }

  if (!CLAW_SIBLING_TOKEN) {
    logger.fatal('CLAW_SIBLING_TOKEN is not set. Exiting.');
    process.exit(1);
  }

  ensureContainerRuntimeRunning();
  cleanupOrphans();
  initDatabase();
  logger.info('Database initialized');

  startServer();
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main();
}
