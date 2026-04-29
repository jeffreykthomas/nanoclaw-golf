import http from 'http';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import {
  APP_PORT,
  ASSISTANT_NAME,
  CLAW_SIBLING_TOKEN,
  COACH_APP_URL,
  COACH_FIRST_RESULT_TIMEOUT,
  DATA_DIR,
} from './config.js';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import {
  clearPendingCheckInMessages,
  getSession,
  getPendingCheckInMessages,
  markCheckInMessagesDelivered,
  setSession,
} from './db.js';
import {
  detectProfileCommand,
  getLatestCheckInContext,
  getLatestProfileSummary,
  getProfileCommandResponse,
  getUserProfileInventoryView,
  queueUserProfileUpdate,
} from './profile/service.js';
import { triggerArccosSyncInBackground } from './arccos-sync.js';
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
  recentProfileContext?: string | null,
): string {
  const contextXml =
    Object.keys(req.context).length > 0
      ? `\n<context>${escapeXml(JSON.stringify(req.context))}</context>`
      : '';
  const profileXml = profileSummary?.trim()
    ? `\n<user-profile-summary>${escapeXml(profileSummary.trim())}</user-profile-summary>`
    : '';
  const recentProfileXml = recentProfileContext?.trim()
    ? `\n<recent-profile-context>${escapeXml(recentProfileContext.trim())}</recent-profile-context>`
    : '';

  return [
    `<coach-request phase="${escapeXml(req.phase)}" userId="${req.userId}">`,
    `<message>${escapeXml(req.message)}</message>`,
    contextXml,
    profileXml,
    recentProfileXml,
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

// ---------------------------------------------------------------------------
// Coach container pool — reuse containers across HTTP requests within a session
// ---------------------------------------------------------------------------

const COACH_IDLE_CLOSE_MS = parseInt(
  process.env.COACH_IDLE_CLOSE_MS || '120000',
  10,
);

interface PendingCoachResponse {
  resolve: (result: { text: string; newSessionId?: string }) => void;
  reject: (err: Error) => void;
  outputChunks: string[];
  rawOutputChunks: string[];
  newSessionId?: string;
  firstResultResolved: boolean;
  coachReq: CoachRequest;
}

interface PooledCoachContainer {
  chatJid: string;
  groupFolder: string;
  idle: boolean;
  exited: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pending: PendingCoachResponse | null;
}

const coachContainerPool = new Map<string, PooledCoachContainer>();

function writeCoachIpcMessage(groupFolder: string, text: string): boolean {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
    fs.renameSync(tempPath, filepath);
    return true;
  } catch {
    return false;
  }
}

function writeCoachIpcClose(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  } catch {
    /* ignore */
  }
}

function scheduleCoachIdleClose(entry: PooledCoachContainer): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.idle && !entry.exited) {
      logger.info({ chatJid: entry.chatJid }, 'Coach container idle close');
      writeCoachIpcClose(entry.groupFolder);
    }
    coachContainerPool.delete(entry.chatJid);
  }, COACH_IDLE_CLOSE_MS);
}

async function doCoachPostResponseWork(
  entry: PooledCoachContainer,
  pending: PendingCoachResponse,
): Promise<void> {
  const userId = String(pending.coachReq.userId);

  await queueUserProfileUpdate({
    userId,
    coachSessionId: pending.coachReq.coachSessionId,
    message: pending.coachReq.message,
    responseText: pending.outputChunks.join('\n\n'),
    context: pending.coachReq.context,
  });

  const insightRequests = extractInsightRequests(
    pending.rawOutputChunks.join('\n'),
    pending.coachReq,
  );
  for (const insightRequest of insightRequests) {
    try {
      await createInsightInCoachApp(insightRequest);
    } catch (error) {
      logger.warn(
        {
          error,
          userId,
          coachSessionId: pending.coachReq.coachSessionId,
          chatJid: entry.chatJid,
        },
        'Insight relay failed after coach response',
      );
    }
  }
}

function handleCoachContainerOutput(
  entry: PooledCoachContainer,
  output: ContainerOutput,
): void {
  if (!entry.pending) return;

  const pending = entry.pending;

  if (output.newSessionId) {
    pending.newSessionId = output.newSessionId;
    setSession(entry.groupFolder, output.newSessionId);
  }

  if (output.result) {
    const raw =
      typeof output.result === 'string'
        ? output.result
        : JSON.stringify(output.result);
    pending.rawOutputChunks.push(raw);
    const text = formatOutbound(raw);
    if (text) {
      pending.outputChunks.push(text);
      if (!pending.firstResultResolved) {
        pending.firstResultResolved = true;
        pending.resolve({
          text: pending.outputChunks.join('\n\n'),
          newSessionId: pending.newSessionId,
        });
      }
    }
  }

  if (output.status === 'success') {
    entry.idle = true;
    const finishedPending = entry.pending;
    entry.pending = null;

    if (!finishedPending.firstResultResolved) {
      finishedPending.firstResultResolved = true;
      finishedPending.resolve({
        text: finishedPending.outputChunks.join('\n\n') || '',
        newSessionId: finishedPending.newSessionId,
      });
    }

    doCoachPostResponseWork(entry, finishedPending).catch((err) => {
      logger.warn({ err, chatJid: entry.chatJid }, 'Post-response work failed');
    });

    scheduleCoachIdleClose(entry);
  }

  if (output.status === 'error') {
    if (!pending.firstResultResolved) {
      pending.firstResultResolved = true;
      pending.reject(new Error('container_error'));
    }
  }
}

function spawnCoachContainer(
  chatJid: string,
  group: RegisteredGroup,
  sessionId: string | undefined,
  prompt: string,
  pending: PendingCoachResponse,
): PooledCoachContainer {
  const entry: PooledCoachContainer = {
    chatJid,
    groupFolder: group.folder,
    idle: false,
    exited: false,
    idleTimer: null,
    pending,
  };
  coachContainerPool.set(chatJid, entry);

  const containerPromise = runContainerAgent(
    group,
    {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain: false,
      assistantName: ASSISTANT_NAME,
    },
    () => {},
    async (streamOutput: ContainerOutput) => {
      handleCoachContainerOutput(entry, streamOutput);
    },
  );

  const cleanup = () => {
    entry.exited = true;
    coachContainerPool.delete(chatJid);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.pending && !entry.pending.firstResultResolved) {
      entry.pending.reject(new Error('container_exited_before_result'));
    }
  };

  containerPromise.then(cleanup).catch(cleanup);

  return entry;
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

  clearPendingCheckInMessages(String(coachReq.userId));

  const reqLogger = logger.child({ requestId: coachReq.requestId });
  reqLogger.info(
    {
      userId: coachReq.userId,
      coachSessionId: coachReq.coachSessionId,
      phase: coachReq.phase,
    },
    'Coach request received',
  );

  const chatJid = `app:coach-${coachReq.coachSessionId}`;
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

  const [profileSummary, recentProfileContext] = await Promise.all([
    getLatestProfileSummary(userId),
    getLatestCheckInContext(userId),
  ]);
  const prompt = buildPrompt(coachReq, profileSummary, recentProfileContext);

  const pending: PendingCoachResponse = {
    resolve: null!,
    reject: null!,
    outputChunks: [],
    rawOutputChunks: [],
    firstResultResolved: false,
    coachReq,
  };

  const resultPromise = new Promise<{ text: string; newSessionId?: string }>(
    (resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    },
  );

  const existingEntry = coachContainerPool.get(chatJid);

  if (existingEntry && !existingEntry.exited && existingEntry.idle) {
    reqLogger.info('Reusing active coach container');
    if (existingEntry.idleTimer) clearTimeout(existingEntry.idleTimer);
    existingEntry.idle = false;
    existingEntry.pending = pending;

    if (!writeCoachIpcMessage(existingEntry.groupFolder, prompt)) {
      reqLogger.warn('IPC write failed, spawning new container');
      coachContainerPool.delete(chatJid);
      const group = getCoachGroup(coachReq.coachSessionId);
      const sessionId = getSession(group.folder);
      spawnCoachContainer(chatJid, group, sessionId, prompt, pending);
    }
  } else {
    const group = getCoachGroup(coachReq.coachSessionId);
    const sessionId = getSession(group.folder);
    spawnCoachContainer(chatJid, group, sessionId, prompt, pending);
  }

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('first_result_timeout')),
        COACH_FIRST_RESULT_TIMEOUT,
      ).unref();
    });

    const firstResult = await Promise.race([resultPromise, timeoutPromise]);

    await sendTelegramMirrorMessage(firstResult.text);
    reqLogger.info(
      { responseLength: firstResult.text.length },
      'Coach response sent',
    );
    jsonResponse(res, 200, { text: firstResult.text });
  } catch (err) {
    const entry = coachContainerPool.get(chatJid);
    if (entry && entry.pending === pending) {
      entry.pending = null;
    }

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

async function handleArccosSyncTrigger(
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
  const obj = (body ?? {}) as Record<string, unknown>;
  const userIdRaw = obj.user_id;
  const userId =
    typeof userIdRaw === 'number'
      ? userIdRaw
      : typeof userIdRaw === 'string'
        ? parseInt(userIdRaw, 10)
        : NaN;
  if (!Number.isInteger(userId) || userId <= 0) {
    jsonResponse(res, 400, { error: 'invalid_user_id' });
    return;
  }
  const force = obj.force !== false;
  triggerArccosSyncInBackground({ userId, force });
  jsonResponse(res, 202, { status: 'accepted', user_id: userId });
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

async function handleProfileInventoryRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!ensureAuthorized(req, res)) {
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const userId = url.searchParams.get('userId');
  if (!userId) {
    jsonResponse(res, 400, { error: 'missing_userId_param' });
    return;
  }

  try {
    const inventory = await getUserProfileInventoryView(userId);
    jsonResponse(res, 200, { inventory });
  } catch (error) {
    logger.warn({ error, userId }, 'Profile inventory request failed');
    jsonResponse(res, 500, { error: 'profile_inventory_failed' });
  }
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
