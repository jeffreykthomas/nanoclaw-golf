import http from 'http';

import { z } from 'zod';

import { CLAW_SIBLING_TOKEN, COACH_FIRST_RESULT_TIMEOUT } from './config.js';
import { runAgentTask } from './agent-task-runner.js';
import { log } from './log.js';
import {
  detectProfileCommand,
  getLatestCheckInContext,
  getLatestProfileSummary,
  getProfileCommandResponse,
  getUserProfileInventoryView,
  queueUserProfileUpdate,
} from './profile/service.js';

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

function jsonResponse(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function ensureAuthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!CLAW_SIBLING_TOKEN || req.headers.authorization !== `Bearer ${CLAW_SIBLING_TOKEN}`) {
    jsonResponse(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  return JSON.parse(raw);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractConversationHistory(context: Record<string, unknown>): unknown[] {
  const raw =
    context.recent_messages ?? context.recentMessages ?? context.conversation_history ?? context.conversationHistory;
  return Array.isArray(raw) ? raw : [];
}

function contextWithoutConversationHistory(context: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...context };
  delete rest.recent_messages;
  delete rest.recentMessages;
  delete rest.conversation_history;
  delete rest.conversationHistory;
  return rest;
}

function contextString(context: Record<string, unknown>, key: string): string {
  const value = context[key];
  return typeof value === 'string' ? value : '';
}

function isLifeModeContext(req: CoachRequest): boolean {
  const appMode = contextString(req.context, 'app_mode') || contextString(req.context, 'appMode');
  const controller = contextString(req.context, 'controller');
  const path = contextString(req.context, 'path');
  return (
    appMode === 'life' ||
    controller.startsWith('self_understanding') ||
    controller.startsWith('learning') ||
    path.includes('/self_understanding') ||
    path.includes('/learning')
  );
}

function isGolfRelatedContext(req: CoachRequest): boolean {
  const message = req.message.toLowerCase();
  const controller = contextString(req.context, 'controller');
  const path = contextString(req.context, 'path');
  const explicitlyNotGolf =
    /\b(not|outside|without|no)\s+(?:the\s+)?golf\b/.test(message) || /\bnot\b[\s\S]{0,80}\bgolf\b/.test(message);
  const explicitGolfRequest =
    !explicitlyNotGolf &&
    /\b(golf|round|course|hole|tee|green|fairway|putt|putting|driver|iron|wedge|handicap|swing|club championship)\b/.test(
      message,
    );
  const golfPageContext =
    Boolean(req.context.course_id || req.context.course_name || req.context.hole_number) ||
    controller === 'courses' ||
    path.startsWith('/courses');

  return explicitGolfRequest || golfPageContext;
}

function systemInstructions(req: CoachRequest): string[] {
  if (isLifeModeContext(req) && !isGolfRelatedContext(req)) {
    return [
      'You are a concise, practical personal coach inside Life Mode.',
      'Support self-understanding, habits, spiritual or mental practices, family/work context, learning, and values-based reflection.',
      'Golf is one possible interest in the user profile, not the default frame. Do not steer the answer toward golf unless the user explicitly brings up golf.',
      'Reply with user-facing text only. If useful, include one clear next action or practice.',
    ];
  }

  return [
    'You are a concise, practical golf coach.',
    'Reply with user-facing text only.',
    'If useful, include one clear next action or drill. Do not invent stored profile data.',
  ];
}

function shouldIncludeProfileSummary(req: CoachRequest): boolean {
  return !isLifeModeContext(req) || isGolfRelatedContext(req);
}

function filteredRecentProfileContext(req: CoachRequest, recentProfileContext?: string | null): string | null {
  if (!recentProfileContext?.trim()) return null;
  if (shouldIncludeProfileSummary(req)) return recentProfileContext.trim();

  const lines = recentProfileContext
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Latest golf thread\b/i.test(line))
    .filter((line) => !/\): golf -/i.test(line));

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildPrompt(
  req: CoachRequest,
  profileSummary?: string | null,
  recentProfileContext?: string | null,
): string {
  const currentDate = new Date().toISOString();
  const conversationHistory = extractConversationHistory(req.context);
  const context = contextWithoutConversationHistory(req.context);
  const contextXml =
    Object.keys(context).length > 0 ? `\n<context>${escapeXml(JSON.stringify(context))}</context>` : '';
  const conversationHistoryXml =
    conversationHistory.length > 0
      ? `\n<conversation-history>${escapeXml(JSON.stringify(conversationHistory))}</conversation-history>`
      : '';
  const profileXml =
    shouldIncludeProfileSummary(req) && profileSummary?.trim()
      ? `\n<user-profile-summary>${escapeXml(profileSummary.trim())}</user-profile-summary>`
      : '';
  const recentContext = filteredRecentProfileContext(req, recentProfileContext);
  const recentProfileXml = recentContext
    ? `\n<recent-profile-context>${escapeXml(recentContext)}</recent-profile-context>`
    : '';

  return [
    ...systemInstructions(req),
    `Current date/time: ${currentDate}.`,
    'Use the current message and conversation history as the freshest context.',
    'Treat long-term profile summaries as background memory. Ignore time-sensitive profile claims unless the current message, conversation history, or recent profile context confirms they are still current.',
    '',
    `<coach-request phase="${escapeXml(req.phase)}" userId="${req.userId}">`,
    `<message>${escapeXml(req.message)}</message>`,
    conversationHistoryXml,
    contextXml,
    profileXml,
    recentProfileXml,
    '</coach-request>',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function handleCoachRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ensureAuthorized(req, res)) return;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    jsonResponse(res, 400, { error: 'invalid_json' });
    return;
  }

  const parsed = CoachRequestSchema.safeParse(body);
  if (!parsed.success) {
    jsonResponse(res, 400, { error: 'validation_error', details: parsed.error.issues });
    return;
  }

  const coachReq = parsed.data;
  if (coachReq.transport !== 'app') {
    jsonResponse(res, 400, { error: 'unsupported_transport' });
    return;
  }

  try {
    const userId = String(coachReq.userId);
    const profileCommand = detectProfileCommand(coachReq.message);
    if (profileCommand) {
      const text = await getProfileCommandResponse({ userId, command: profileCommand });
      jsonResponse(res, 200, { text });
      return;
    }

    const [profileSummary, recentProfileContext] = await Promise.all([
      getLatestProfileSummary(userId),
      getLatestCheckInContext(userId),
    ]);

    const result = await runAgentTask({
      folder: `coach-${coachReq.coachSessionId}`,
      name: `Coach Session ${coachReq.coachSessionId}`,
      prompt: buildPrompt(coachReq, profileSummary, recentProfileContext),
      timeoutMs: COACH_FIRST_RESULT_TIMEOUT,
      channelType: 'internal-coach',
      platformId: `coach:${coachReq.coachSessionId}`,
    });

    void queueUserProfileUpdate({
      userId,
      coachSessionId: coachReq.coachSessionId,
      message: coachReq.message,
      responseText: result.text,
      context: coachReq.context,
    });

    log.info('Coach response sent', {
      requestId: coachReq.requestId,
      userId: coachReq.userId,
      coachSessionId: coachReq.coachSessionId,
      responseLength: result.text.length,
    });
    jsonResponse(res, 200, { text: result.text });
  } catch (err) {
    log.error('Coach request failed', { requestId: coachReq.requestId, err });
    jsonResponse(res, 500, { error: 'internal_error' });
  }
}

export async function handleProfileInventoryRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!ensureAuthorized(req, res)) return;

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const userId = url.searchParams.get('userId') || url.searchParams.get('user_id');
  if (!userId) {
    jsonResponse(res, 400, { error: 'user_id_required' });
    return;
  }

  try {
    const inventory = await getUserProfileInventoryView(userId);
    jsonResponse(res, 200, { inventory });
  } catch (err) {
    log.error('Profile inventory request failed', { userId, err });
    jsonResponse(res, 500, { error: 'internal_error' });
  }
}
