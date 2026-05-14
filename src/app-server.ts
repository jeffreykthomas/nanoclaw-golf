import http from 'http';
import path from 'path';

import {
  APP_PORT,
  BIPBOT_FIREBASE_SERVICE_ACCOUNT_PATH,
  BIPBOT_INGRESS_AGENT_FOLDER,
  BIPBOT_INGRESS_AGENT_NAME,
  BIPBOT_REPO_URL,
  CLAW_SIBLING_TOKEN,
  DATA_DIR,
  ENABLE_COACH_AGENT,
} from './config.js';
import { runAgentTask } from './agent-task-runner.js';
import { startArccosSyncLoop, triggerArccosSyncInBackground } from './arccos-sync.js';
import { startBipbotIngressPoller, type BipbotIngressEvent } from './bipbot-ingress-poller.js';
import { startAutoCheckInLoop } from './checkin-engine.js';
import { handleCoachRequest, handleProfileInventoryRequest } from './coach-http.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { handleLearningRequest } from './learning-http.js';
import { log } from './log.js';
import { startSelfUnderstandingReportsLoop } from './report-sync.js';
import { sendTelegramMirrorMessage } from './telegram-notifier.js';

function jsonResponse(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function authorized(req: http.IncomingMessage): boolean {
  return Boolean(CLAW_SIBLING_TOKEN) && req.headers.authorization === `Bearer ${CLAW_SIBLING_TOKEN}`;
}

async function handleArccosSyncTrigger(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authorized(req)) {
    jsonResponse(res, 401, { error: 'unauthorized' });
    return;
  }
  let body: { user_id?: unknown; force?: unknown };
  try {
    const raw = await readBody(req);
    body = raw ? (JSON.parse(raw) as { user_id?: unknown; force?: unknown }) : {};
  } catch {
    jsonResponse(res, 400, { error: 'invalid_json' });
    return;
  }
  if (typeof body.user_id !== 'number') {
    jsonResponse(res, 400, { error: 'user_id_required' });
    return;
  }

  triggerArccosSyncInBackground({ userId: body.user_id, force: body.force === true });
  jsonResponse(res, 202, { status: 'queued' });
}

function buildBipbotPrompt(event: BipbotIngressEvent): string {
  const repoUrl = event.repoUrl || BIPBOT_REPO_URL;
  return [
    '[BipBot ingress]',
    `Issue: ${event.issueId}`,
    event.issueUrl ? `URL: ${event.issueUrl}` : '',
    repoUrl ? `Repository: ${repoUrl}` : '',
    event.branch ? `Target branch: ${event.branch}` : '',
    event.sourceType ? `Source: ${event.sourceType}` : '',
    'Workflow: evaluate this issue and, when implementation is warranted, queue the downstream work with `bipbot_create_codex_job`. Do not require a chat destination and do not open a PR directly.',
    event.branch
      ? `Branch discipline: inspect and queue downstream work against \`${event.branch}\`; do not validate against \`main\` unless the issue explicitly targets \`main\`.`
      : '',
    '',
    event.prompt,
  ]
    .filter(Boolean)
    .join('\n');
}

async function queueBipbotIngressTask(event: BipbotIngressEvent): Promise<void> {
  await runAgentTask({
    folder: BIPBOT_INGRESS_AGENT_FOLDER,
    name: BIPBOT_INGRESS_AGENT_NAME,
    prompt: buildBipbotPrompt(event),
    timeoutMs: 10 * 60 * 1000,
    channelType: 'bipbot-ingress',
    platformId: `bipbot:${event.issueId}`,
  });
}

export async function startAppHttpServer(options?: { continueOnPortInUse?: boolean }): Promise<http.Server | null> {
  const continueOnPortInUse = options?.continueOnPortInUse === true;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      jsonResponse(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/learning/respond') {
      await handleLearningRequest(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/coach/respond') {
      await handleCoachRequest(req, res);
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/v1/profile/inventory')) {
      await handleProfileInventoryRequest(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/arccos/sync') {
      await handleArccosSyncTrigger(req, res);
      return;
    }

    jsonResponse(res, 404, { error: 'not_found' });
  });

  return new Promise<http.Server | null>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (continueOnPortInUse && err.code === 'EADDRINUSE') {
        log.warn('App API port already in use; skipping embedded HTTP server', { port: APP_PORT });
        resolve(null);
        return;
      }
      reject(err);
    };

    const onListening = () => {
      server.off('error', onError);
      log.info('App API server listening', { port: APP_PORT });
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(APP_PORT);
  });
}

export async function startAppBridgeRuntime(): Promise<http.Server | null> {
  const server = await startAppHttpServer({ continueOnPortInUse: true });
  startSelfUnderstandingReportsLoop();
  startArccosSyncLoop();
  startAutoCheckInLoop(sendTelegramMirrorMessage);
  if (BIPBOT_FIREBASE_SERVICE_ACCOUNT_PATH) {
    await startBipbotIngressPoller(BIPBOT_FIREBASE_SERVICE_ACCOUNT_PATH, {
      onIngressEvent: queueBipbotIngressTask,
    });
  }
  return server;
}

async function main(): Promise<void> {
  if (!ENABLE_COACH_AGENT) {
    log.fatal('ENABLE_COACH_AGENT is not set to true. Exiting.');
    process.exit(1);
  }

  if (!CLAW_SIBLING_TOKEN) {
    log.fatal('CLAW_SIBLING_TOKEN is not set. Exiting.');
    process.exit(1);
  }

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  const server = await startAppBridgeRuntime();
  const shutdown = (signal: string) => {
    log.info('Shutdown signal received', { signal });
    if (!server) {
      process.exit(0);
      return;
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isDirectRun =
  process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    log.error('Failed to start app API', { err });
    process.exit(1);
  });
}
