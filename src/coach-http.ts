import http from 'http';
import fs from 'fs';

import { z } from 'zod';

import {
  APP_PORT,
  ASSISTANT_NAME,
  CLAW_SIBLING_TOKEN,
  COACH_APP_URL,
  COACH_FIRST_RESULT_TIMEOUT,
} from './config.js';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import {
  getSession,
  getPendingCheckInMessages,
  markCheckInMessagesDelivered,
  setSession,
} from './db.js';
import {
  detectProfileCommand,
  getLatestProfileSummary,
  getProfileCommandResponse,
  queueUserProfileUpdate,
} from './profile/service.js';
import { handleLearningRequest } from './learning-http.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { escapeXml, formatOutbound } from './router.js';
import { sendTelegramMirrorMessage } from './telegram-notifier.js';
import { RegisteredGroup } from './types.js';

export const CoachRequestSchema = z.object({
  requestId: z.string(),
  transport: z.string(),
  userId: z.number(),
  coachSessionId: z.number(),
  phase: z.enum(['onboarding', 'pre_round', 'during_round', 'post_round']),
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional().default({}),
});

export type CoachRequest = z.infer<typeof CoachRequestSchema>;

export const CoachInsightRequestSchema = z.object({
  userId: z.number(),
  coachSessionId: z.number(),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  categorySlug: z.string().optional(),
});

export type CoachInsightRequest = z.infer<typeof CoachInsightRequestSchema>;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxBody = 1_048_576;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
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

function ensureAuthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${CLAW_SIBLING_TOKEN}`) {
    jsonResponse(res, 401, { error: 'unauthorized' });
    return false;
  }

  return true;
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  return JSON.parse(raw);
}

function buildCoachAppInsightUrl(coachSessionId: number): URL {
  if (!COACH_APP_URL) {
    throw new Error('coach_app_url_not_configured');
  }

  return new URL(
    `/internal/coach_sessions/${coachSessionId}/insights`,
    COACH_APP_URL.endsWith('/') ? COACH_APP_URL : `${COACH_APP_URL}/`,
  );
}

async function createInsightInCoachApp(
  payload: CoachInsightRequest,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    buildCoachAppInsightUrl(payload.coachSessionId),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CLAW_SIBLING_TOKEN}`,
      },
      body: JSON.stringify({
        user_id: payload.userId,
        title: payload.title,
        content: payload.content,
        tags: payload.tags,
        category_slug: payload.categorySlug,
      }),
    },
  );

  const bodyText = await response.text();
  const parsedBody = bodyText
    ? (JSON.parse(bodyText) as Record<string, unknown>)
    : {};
  if (!response.ok) {
    throw new Error(
      `coach_app_insight_failed_${response.status}:${parsedBody.error || bodyText || 'unknown_error'}`,
    );
  }

  return parsedBody;
}

export function extractInsightRequests(
  rawText: string,
  coachReq: CoachRequest,
): CoachInsightRequest[] {
  const requests: CoachInsightRequest[] = [];
  const matches = rawText.matchAll(/<save-insight>([\s\S]*?)<\/save-insight>/g);

  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
      const validated = CoachInsightRequestSchema.safeParse({
        userId: coachReq.userId,
        coachSessionId: coachReq.coachSessionId,
        title: parsed.title,
        content: parsed.content,
        tags: parsed.tags,
        categorySlug: parsed.categorySlug || parsed.category_slug,
      });
      if (validated.success) {
        requests.push(validated.data);
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to parse save-insight block');
    }
  }

  return requests;
}

export function buildPrompt(
  req: CoachRequest,
  profileSummary?: string | null,
): string {
  const contextXml =
    Object.keys(req.context).length > 0
      ? `\n<context>${escapeXml(JSON.stringify(req.context))}</context>`
      : '';
  const profileXml = profileSummary?.trim()
    ? `\n<user-profile-summary>${escapeXml(profileSummary.trim())}</user-profile-summary>`
    : '';

  return [
    `<coach-request phase="${escapeXml(req.phase)}" userId="${req.userId}">`,
    `<message>${escapeXml(req.message)}</message>`,
    contextXml,
    profileXml,
    `</coach-request>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function getCoachGroup(coachSessionId: number): RegisteredGroup {
  const folder = `coach-${coachSessionId}`;
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

async function handleCoachRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!ensureAuthorized(req, res)) {
    return;
  }

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    jsonResponse(res, 400, { error: 'invalid_json' });
    return;
  }

  const parsed = CoachRequestSchema.safeParse(body);
  if (!parsed.success) {
    jsonResponse(res, 400, {
      error: 'validation_error',
      details: parsed.error.issues,
    });
    return;
  }
  const coachReq = parsed.data;

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

  const group = getCoachGroup(coachReq.coachSessionId);
  const sessionId = getSession(group.folder);
  const userId = String(coachReq.userId);
  const profileCommand = detectProfileCommand(coachReq.message);
  if (profileCommand) {
    const text = await getProfileCommandResponse({
      userId,
      command: profileCommand,
    });
    await sendTelegramMirrorMessage(text);
    jsonResponse(res, 200, { text });
    return;
  }

  const profileSummary = await getLatestProfileSummary(userId);
  const prompt = buildPrompt(coachReq, profileSummary);

  const outputChunks: string[] = [];
  const rawOutputChunks: string[] = [];
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
      () => {
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
          rawOutputChunks.push(raw);
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

    outputPromise.catch((err) => {
      reqLogger.warn({ err }, 'Container promise rejected after response');
    });

    outputPromise
      .then(async () => {
        await queueUserProfileUpdate({
          userId,
          coachSessionId: coachReq.coachSessionId,
          message: coachReq.message,
          responseText: outputChunks.join('\n\n'),
          context: coachReq.context,
        });

        const insightRequests = extractInsightRequests(
          rawOutputChunks.join('\n'),
          coachReq,
        );
        for (const insightRequest of insightRequests) {
          try {
            await createInsightInCoachApp(insightRequest);
          } catch (error) {
            reqLogger.warn(
              { error, userId, coachSessionId: coachReq.coachSessionId },
              'Insight relay failed after coach response',
            );
          }
        }
      })
      .catch((err) => {
        reqLogger.warn(
          { err, userId },
          'Profile update failed after coach response',
        );
      });

    const combinedText = firstResult.text;
    await sendTelegramMirrorMessage(combinedText);
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

async function handleCoachInsightRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!ensureAuthorized(req, res)) {
    return;
  }

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    jsonResponse(res, 400, { error: 'invalid_json' });
    return;
  }

  const parsed = CoachInsightRequestSchema.safeParse(body);
  if (!parsed.success) {
    jsonResponse(res, 400, {
      error: 'validation_error',
      details: parsed.error.issues,
    });
    return;
  }

  try {
    const result = await createInsightInCoachApp(parsed.data);
    jsonResponse(res, 200, result);
  } catch (error) {
    logger.warn({ error }, 'Coach insight relay failed');
    jsonResponse(res, 502, { error: 'coach_insight_relay_failed' });
  }
}

function handleCheckInsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (!ensureAuthorized(req, res)) {
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const userId = url.searchParams.get('userId');
  if (!userId) {
    jsonResponse(res, 400, { error: 'missing_userId_param' });
    return;
  }

  const pending = getPendingCheckInMessages(userId);
  if (pending.length > 0) {
    markCheckInMessagesDelivered(pending.map((m) => m.id));
  }

  jsonResponse(res, 200, {
    messages: pending.map((m) => ({
      id: m.id,
      message: m.message,
      created_at: m.created_at,
    })),
  });
}

export async function startCoachHttpServer(options?: {
  continueOnPortInUse?: boolean;
}): Promise<http.Server | null> {
  const continueOnPortInUse = options?.continueOnPortInUse === true;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      jsonResponse(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/coach/respond') {
      await handleCoachRequest(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/coach/insights') {
      await handleCoachInsightRequest(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/learning/respond') {
      await handleLearningRequest(req, res);
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/v1/coach/checkins')) {
      handleCheckInsRequest(req, res);
      return;
    }

    jsonResponse(res, 404, { error: 'not_found' });
  });

  return new Promise<http.Server | null>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (continueOnPortInUse && err.code === 'EADDRINUSE') {
        logger.warn(
          { port: APP_PORT },
          'Coach API port already in use; skipping embedded coach HTTP server',
        );
        resolve(null);
        return;
      }
      reject(err);
    };

    const onListening = () => {
      server.off('error', onError);
      logger.info({ port: APP_PORT }, 'Coach API server listening');
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(APP_PORT);
  });
}
