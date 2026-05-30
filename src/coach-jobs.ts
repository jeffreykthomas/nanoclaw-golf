import fs from 'fs';
import http from 'http';
import path from 'path';

import { CLAW_SIBLING_TOKEN, DATA_DIR } from './config.js';
import { getAgentTaskOutput, parseOutputText, queueAgentTask } from './agent-task-runner.js';
import { buildPrompt, CoachRequestSchema, extractResearchProposals } from './coach-http.js';
import { log } from './log.js';
import {
  detectProfileCommand,
  getLatestCheckInContext,
  getLatestProfileSummary,
  getProfileCommandResponse,
  queueUserProfileUpdate,
} from './profile/service.js';

type CoachJobStatus = 'queued' | 'running' | 'completed' | 'failed';

interface CoachJobRecord {
  id: string;
  requestId: string;
  status: CoachJobStatus;
  userId: number;
  coachSessionId: number;
  phase: string;
  message: string;
  context: Record<string, unknown>;
  agentGroupId: string;
  sessionId: string;
  messageId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  payload?: Record<string, unknown>;
  rawText?: string;
  profileUpdateQueued?: boolean;
}

// Coach replies are quick relative to learning research, but allow generous
// headroom for a cold container start plus the agent's own work.
const COACH_JOB_TIMEOUT_MS = 15 * 60 * 1000;

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

function coachJobsDir(): string {
  const dir = path.join(DATA_DIR, 'app-coach-jobs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function coachJobPath(jobId: string): string {
  return path.join(coachJobsDir(), `${safeJobId(jobId)}.json`);
}

function readCoachJob(jobId: string): CoachJobRecord | null {
  try {
    return JSON.parse(fs.readFileSync(coachJobPath(jobId), 'utf8')) as CoachJobRecord;
  } catch {
    return null;
  }
}

function writeCoachJob(job: CoachJobRecord): void {
  fs.writeFileSync(coachJobPath(job.id), `${JSON.stringify(job, null, 2)}\n`);
}

function publicCoachJob(job: CoachJobRecord): Record<string, unknown> {
  return {
    id: job.id,
    requestId: job.requestId,
    status: job.status,
    userId: job.userId,
    coachSessionId: job.coachSessionId,
    sessionId: job.sessionId,
    messageId: job.messageId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    error: job.error,
  };
}

function markCoachJobFailed(job: CoachJobRecord, error: string): CoachJobRecord {
  const now = new Date().toISOString();
  return {
    ...job,
    status: 'failed',
    error,
    failedAt: now,
    updatedAt: now,
  };
}

function queueCoachProfileUpdate(job: CoachJobRecord, rawText: string): void {
  if (job.profileUpdateQueued) return;
  void queueUserProfileUpdate({
    userId: String(job.userId),
    coachSessionId: job.coachSessionId,
    message: job.message,
    responseText: rawText,
    context: job.context,
  });
  job.profileUpdateQueued = true;
}

async function respondWithCoachJobStatus(record: CoachJobRecord, res: http.ServerResponse): Promise<void> {
  let job = record;

  if (job.status === 'completed' && job.payload) {
    jsonResponse(res, 200, {
      status: job.status,
      job: publicCoachJob(job),
      payload: job.payload,
      rawText: job.rawText,
      sessionId: job.sessionId,
    });
    return;
  }

  if (job.status === 'failed') {
    jsonResponse(res, 200, {
      status: job.status,
      job: publicCoachJob(job),
      error: job.error,
    });
    return;
  }

  const rawMessage = getAgentTaskOutput(job.agentGroupId, job.sessionId, job.messageId);
  if (!rawMessage) {
    const elapsedMs = Date.now() - Date.parse(job.createdAt);
    if (elapsedMs > COACH_JOB_TIMEOUT_MS) {
      job = markCoachJobFailed(job, `coach_job_timeout:${job.messageId}`);
      writeCoachJob(job);
      log.error('Coach job timed out', {
        requestId: job.requestId,
        userId: job.userId,
        coachSessionId: job.coachSessionId,
        messageId: job.messageId,
      });
      jsonResponse(res, 200, {
        status: job.status,
        job: publicCoachJob(job),
        error: job.error,
      });
      return;
    }

    if (job.status === 'queued') {
      job = {
        ...job,
        status: 'running',
        updatedAt: new Date().toISOString(),
      };
      writeCoachJob(job);
    }

    jsonResponse(res, 200, {
      status: job.status,
      job: publicCoachJob(job),
    });
    return;
  }

  const rawText = parseOutputText(rawMessage.content);
  const responsePayload = extractResearchProposals(rawText);
  const now = new Date().toISOString();
  job = {
    ...job,
    status: 'completed',
    payload: {
      text: responsePayload.text,
      researchProposals: responsePayload.researchProposals,
    },
    rawText,
    completedAt: now,
    updatedAt: now,
  };
  queueCoachProfileUpdate(job, rawText);
  writeCoachJob(job);
  log.info('Coach job completed', {
    requestId: job.requestId,
    userId: job.userId,
    coachSessionId: job.coachSessionId,
    responseLength: responsePayload.text.length,
    researchProposalCount: responsePayload.researchProposals.length,
  });

  jsonResponse(res, 200, {
    status: job.status,
    job: publicCoachJob(job),
    payload: job.payload,
    rawText,
    sessionId: job.sessionId,
  });
}

export async function handleCoachJobCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

  const existing = readCoachJob(coachReq.requestId);
  if (existing) {
    await respondWithCoachJobStatus(existing, res);
    return;
  }

  try {
    const userId = String(coachReq.userId);

    // Profile commands resolve synchronously without spawning an agent.
    const profileCommand = detectProfileCommand(coachReq.message);
    if (profileCommand) {
      const text = await getProfileCommandResponse({ userId, command: profileCommand });
      const now = new Date().toISOString();
      const job: CoachJobRecord = {
        id: coachReq.requestId,
        requestId: coachReq.requestId,
        status: 'completed',
        userId: coachReq.userId,
        coachSessionId: coachReq.coachSessionId,
        phase: coachReq.phase,
        message: coachReq.message,
        context: coachReq.context,
        agentGroupId: '',
        sessionId: '',
        messageId: '',
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        payload: { text, researchProposals: [] },
        rawText: text,
        profileUpdateQueued: true,
      };
      writeCoachJob(job);
      jsonResponse(res, 200, {
        status: job.status,
        job: publicCoachJob(job),
        payload: job.payload,
        rawText: text,
      });
      return;
    }

    const [profileSummary, recentProfileContext] = await Promise.all([
      getLatestProfileSummary(userId),
      getLatestCheckInContext(userId),
    ]);

    const queued = await queueAgentTask({
      folder: `coach-${coachReq.coachSessionId}`,
      name: `Coach Session ${coachReq.coachSessionId}`,
      prompt: buildPrompt(coachReq, profileSummary, recentProfileContext),
      timeoutMs: COACH_JOB_TIMEOUT_MS,
      channelType: 'internal-coach',
      platformId: `coach:${coachReq.coachSessionId}`,
    });

    const now = new Date().toISOString();
    const job: CoachJobRecord = {
      id: coachReq.requestId,
      requestId: coachReq.requestId,
      status: 'queued',
      userId: coachReq.userId,
      coachSessionId: coachReq.coachSessionId,
      phase: coachReq.phase,
      message: coachReq.message,
      context: coachReq.context,
      agentGroupId: queued.agentGroup.id,
      sessionId: queued.sessionId,
      messageId: queued.messageId,
      createdAt: now,
      updatedAt: now,
    };
    writeCoachJob(job);

    log.info('Coach job queued', {
      requestId: job.requestId,
      userId: job.userId,
      coachSessionId: job.coachSessionId,
      sessionId: job.sessionId,
      messageId: job.messageId,
    });

    jsonResponse(res, 202, {
      status: job.status,
      job: publicCoachJob(job),
    });
  } catch (err) {
    log.error('Coach job queue failed', { requestId: coachReq.requestId, err });
    jsonResponse(res, 500, { error: 'internal_error' });
  }
}

export async function handleCoachJobStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
): Promise<void> {
  if (!ensureAuthorized(req, res)) return;

  const job = readCoachJob(jobId);
  if (!job) {
    jsonResponse(res, 404, { error: 'not_found' });
    return;
  }

  await respondWithCoachJobStatus(job, res);
}
