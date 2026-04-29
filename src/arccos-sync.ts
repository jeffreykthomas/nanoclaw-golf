import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import {
  ARCCOS_SYNC_ALLOWED_HOURS,
  ARCCOS_SYNC_ALLOWED_WEEKDAYS,
  ARCCOS_SYNC_BATCH_LIMIT,
  ARCCOS_SYNC_CUTOFF_MONTHS,
  ARCCOS_SYNC_LOOP_INTERVAL_MS,
  ARCCOS_SYNC_MAX_ROUNDS,
  ARCCOS_SYNC_TIMEOUT_MS,
  ASSISTANT_NAME,
  AUTO_ARCCOS_SYNC_ENABLED,
  CLAW_SIBLING_TOKEN,
  COACH_APP_URL,
  DATA_DIR,
  TIMEZONE,
} from './config.js';
import { runContainerAgent } from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import { getSession, initDatabase, setSession } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { extractStructuredPayload } from './learning-http.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// ---------------- Schemas ----------------

const PendingTaskSchema = z.object({
  user_id: z.number(),
  cutoff_date: z.string().optional(), // YYYY-MM-DD
  known_external_ids: z.array(z.string()).default([]),
  max_rounds: z.number().int().positive().optional(),
  force: z.boolean().optional(),
});
const PendingResponseSchema = z.object({
  tasks: z.array(PendingTaskSchema).default([]),
});

const RoundSchema = z
  .object({
    external_id: z.string().optional(),
    played_on: z.string(),
    course_name: z.string(),
    holes_played: z.number().int().positive().default(18),
    total_score: z.number().int().optional(),
    total_par: z.number().int().optional(),
    sg_off_tee: z.number().optional(),
    sg_approach: z.number().optional(),
    sg_short_game: z.number().optional(),
    sg_putting: z.number().optional(),
    sg_total: z.number().optional(),
    putts: z.number().int().optional(),
    greens_in_regulation: z.number().int().optional(),
    fairways_hit: z.number().int().optional(),
    fairways_attempted: z.number().int().optional(),
    raw_payload: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ProfileSchema = z
  .object({
    handicap_index: z.number().optional(),
    scoring_average: z.number().optional(),
    rounds_tracked: z.number().int().optional(),
    smart_distances: z.record(z.string(), z.unknown()).optional(),
    aggregate_strokes_gained: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const SyncPayloadSchema = z.object({
  status: z.enum(['ok', 'partial', 'error']),
  error: z.string().optional(),
  message: z.string().optional(),
  profile: ProfileSchema.optional(),
  rounds: z.array(RoundSchema).default([]),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type PendingArccosTask = z.infer<typeof PendingTaskSchema>;
export type ArccosSyncPayload = z.infer<typeof SyncPayloadSchema>;

// ---------------- HTTP helpers ----------------

function buildRailsUrl(p: string): URL {
  const base = COACH_APP_URL.endsWith('/')
    ? COACH_APP_URL
    : `${COACH_APP_URL}/`;
  return new URL(p.replace(/^\//, ''), base);
}

async function fetchPendingTasks(options?: {
  limit?: number;
  force?: boolean;
  userId?: number;
}): Promise<PendingArccosTask[]> {
  const url = buildRailsUrl('internal/arccos_syncs/pending');
  if (options?.limit) url.searchParams.set('limit', String(options.limit));
  if (options?.force) url.searchParams.set('force', '1');
  if (options?.userId) url.searchParams.set('user_id', String(options.userId));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${CLAW_SIBLING_TOKEN}`,
      Accept: 'application/json',
    },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `arccos_pending_failed_${response.status}:${bodyText.slice(0, 200)}`,
    );
  }
  const parsed = PendingResponseSchema.safeParse(
    bodyText ? JSON.parse(bodyText) : { tasks: [] },
  );
  if (!parsed.success) {
    throw new Error(
      `arccos_pending_parse_failed:${parsed.error.issues.map((i) => i.message).join(',')}`,
    );
  }
  return parsed.data.tasks;
}

async function postStart(userId: number): Promise<void> {
  await fetch(buildRailsUrl('internal/arccos_syncs/start'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLAW_SIBLING_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId }),
  });
}

async function postResult(
  userId: number,
  payload: ArccosSyncPayload,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(buildRailsUrl('internal/arccos_syncs'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLAW_SIBLING_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, payload }),
  });
  const bodyText = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    body = { raw: bodyText.slice(0, 500) };
  }
  return { status: response.status, body };
}

async function postFail(userId: number, message: string): Promise<void> {
  await fetch(buildRailsUrl('internal/arccos_syncs/fail'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLAW_SIBLING_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, message: message.slice(0, 1000) }),
  });
}

// ---------------- Container orchestration ----------------

function writeSyncIpcClose(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  } catch {
    /* ignore */
  }
}

function getSyncGroup(userId: number): RegisteredGroup {
  const folder = `arccos_sync_u${userId}`;
  const groupDir = resolveGroupFolderPath(folder);
  fs.mkdirSync(groupDir, { recursive: true });
  return {
    name: `Arccos Sync ${userId}`,
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };
}

function defaultCutoffDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - ARCCOS_SYNC_CUTOFF_MONTHS);
  return d.toISOString().slice(0, 10);
}

function buildPrompt(task: PendingArccosTask): string {
  const cutoff = task.cutoff_date || defaultCutoffDate();
  const maxRounds = task.max_rounds || ARCCOS_SYNC_MAX_ROUNDS;
  const known = task.known_external_ids.join(',');
  return [
    'Use the arccos-golf skill in Sync Mode to extract round data from the Arccos dashboard.',
    '',
    'ARCCOS_SYNC_MODE=1',
    `ARCCOS_CUTOFF_DATE=${cutoff}`,
    `ARCCOS_MAX_ROUNDS=${maxRounds}`,
    `ARCCOS_KNOWN_EXTERNAL_IDS=${known}`,
    '',
    'Follow the skill exactly. Your FINAL message must be ONE fenced JSON block matching',
    'the schema in the skill — nothing else after it, no commentary.',
  ].join('\n');
}

async function runArccosSyncForTask(
  task: PendingArccosTask,
): Promise<ArccosSyncPayload> {
  const group = getSyncGroup(task.user_id);
  const sessionId = getSession(group.folder);
  let newSessionId: string | undefined;

  let firstResultResolved = false;
  let resolveFirstResult: ((value: ArccosSyncPayload) => void) | null = null;
  let rejectFirstResult: ((reason?: Error) => void) | null = null;

  const firstResultPromise = new Promise<ArccosSyncPayload>(
    (resolve, reject) => {
      resolveFirstResult = resolve;
      rejectFirstResult = reject;
    },
  );

  const prompt = buildPrompt(task);
  const outputPromise = runContainerAgent(
    group,
    {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: `app:arccos-sync-${task.user_id}`,
      isMain: false,
      assistantName: ASSISTANT_NAME,
    },
    () => {},
    async (streamOutput) => {
      if (streamOutput.newSessionId) {
        newSessionId = streamOutput.newSessionId;
        setSession(group.folder, streamOutput.newSessionId);
      }
      if (!streamOutput.result || firstResultResolved || !resolveFirstResult) {
        return;
      }
      const rawText =
        typeof streamOutput.result === 'string'
          ? streamOutput.result
          : JSON.stringify(streamOutput.result);
      try {
        const structured = extractStructuredPayload(rawText);
        if (!structured) return;
        const parsed = SyncPayloadSchema.safeParse(structured);
        if (!parsed.success) return;
        firstResultResolved = true;
        writeSyncIpcClose(group.folder);
        resolveFirstResult(parsed.data);
      } catch {
        /* keep waiting */
      }
    },
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      writeSyncIpcClose(group.folder);
      reject(new Error('arccos_sync_timeout'));
    }, ARCCOS_SYNC_TIMEOUT_MS).unref();
  });

  outputPromise
    .then((output) => {
      if (output.newSessionId) setSession(group.folder, output.newSessionId);
      if (firstResultResolved || !rejectFirstResult) return;
      writeSyncIpcClose(group.folder);
      rejectFirstResult(
        new Error(output.error || 'arccos_structured_payload_missing'),
      );
    })
    .catch((error) => {
      if (firstResultResolved || !rejectFirstResult) return;
      writeSyncIpcClose(group.folder);
      rejectFirstResult(
        error instanceof Error ? error : new Error(String(error)),
      );
    });

  const result = await Promise.race([firstResultPromise, timeoutPromise]);
  void newSessionId;
  return result;
}

// ---------------- Public API ----------------

export interface ArccosSyncSummary {
  attempted: number;
  succeeded: number;
  partial: number;
  failed: number;
  rounds_inserted: number;
  rounds_updated: number;
}

export async function syncArccosOnce(options?: {
  limit?: number;
  force?: boolean;
  userId?: number;
}): Promise<ArccosSyncSummary> {
  const limit = Math.max(
    1,
    Math.min(options?.limit ?? ARCCOS_SYNC_BATCH_LIMIT, 10),
  );
  const summary: ArccosSyncSummary = {
    attempted: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    rounds_inserted: 0,
    rounds_updated: 0,
  };

  let tasks: PendingArccosTask[] = [];
  try {
    tasks = await fetchPendingTasks({
      limit,
      force: options?.force,
      userId: options?.userId,
    });
  } catch (error) {
    logger.warn({ err: error }, 'Arccos pending fetch failed');
    summary.failed += 1;
    return summary;
  }

  if (tasks.length === 0) {
    logger.info('Arccos pending empty');
    return summary;
  }

  for (const task of tasks) {
    summary.attempted += 1;
    const taskLog = logger.child({ userId: task.user_id });
    try {
      await postStart(task.user_id);
      const payload = await runArccosSyncForTask(task);
      const post = await postResult(task.user_id, payload);
      const insertedRaw = post.body.rounds_inserted;
      const updatedRaw = post.body.rounds_updated;
      const inserted = typeof insertedRaw === 'number' ? insertedRaw : 0;
      const updated = typeof updatedRaw === 'number' ? updatedRaw : 0;
      summary.rounds_inserted += inserted;
      summary.rounds_updated += updated;
      if (payload.status === 'ok') {
        summary.succeeded += 1;
        taskLog.info(
          { inserted, updated, rounds: payload.rounds.length },
          'Arccos sync ok',
        );
      } else if (payload.status === 'partial') {
        summary.partial += 1;
        taskLog.warn(
          { inserted, updated, warnings: payload.meta?.['warnings'] },
          'Arccos sync partial',
        );
      } else {
        summary.failed += 1;
        taskLog.warn(
          { error: payload.error, message: payload.message },
          'Arccos sync error from agent',
        );
        await postFail(
          task.user_id,
          payload.message || payload.error || 'unknown',
        );
      }
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      taskLog.warn({ err: error }, 'Arccos sync failed');
      try {
        await postFail(task.user_id, message);
      } catch {
        /* swallow */
      }
    }
  }

  logger.info({ summary }, 'Arccos sync finished');
  return summary;
}

function currentHourInTimezone(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: TIMEZONE,
  }).format(now);
  return parseInt(hour, 10);
}

function currentWeekdayInTimezone(now: Date): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: TIMEZONE,
  }).format(now);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? new Date().getDay();
}

export function startArccosSyncLoop(): void {
  if (!AUTO_ARCCOS_SYNC_ENABLED) {
    logger.info('Arccos sync loop disabled');
    return;
  }
  if (!CLAW_SIBLING_TOKEN || !COACH_APP_URL) {
    logger.warn(
      'Arccos sync loop skipped: CLAW_SIBLING_TOKEN or COACH_APP_URL not configured',
    );
    return;
  }

  let running = false;

  const loop = async () => {
    if (running) {
      setTimeout(loop, ARCCOS_SYNC_LOOP_INTERVAL_MS).unref();
      return;
    }
    running = true;
    try {
      const now = new Date();
      const hour = currentHourInTimezone(now);
      const weekday = currentWeekdayInTimezone(now);
      const hourOk =
        ARCCOS_SYNC_ALLOWED_HOURS.length === 0 ||
        ARCCOS_SYNC_ALLOWED_HOURS.includes(hour);
      const dayOk =
        ARCCOS_SYNC_ALLOWED_WEEKDAYS.length === 0 ||
        ARCCOS_SYNC_ALLOWED_WEEKDAYS.includes(weekday);
      if (!hourOk || !dayOk) {
        logger.debug(
          { hour, weekday, hourOk, dayOk },
          'Arccos sync loop outside allowed window',
        );
      } else {
        await syncArccosOnce();
      }
    } catch (error) {
      logger.warn({ err: error }, 'Arccos sync loop tick failed');
    } finally {
      running = false;
      setTimeout(loop, ARCCOS_SYNC_LOOP_INTERVAL_MS).unref();
    }
  };

  logger.info(
    {
      intervalMs: ARCCOS_SYNC_LOOP_INTERVAL_MS,
      allowedHours: ARCCOS_SYNC_ALLOWED_HOURS,
      allowedWeekdays: ARCCOS_SYNC_ALLOWED_WEEKDAYS,
      cutoffMonths: ARCCOS_SYNC_CUTOFF_MONTHS,
    },
    'Arccos sync loop started',
  );
  void loop();
}

// Fire-and-forget manual trigger used by the HTTP "Sync now" endpoint.
// Returns immediately; the actual sync runs in the background.
export function triggerArccosSyncInBackground(options: {
  userId: number;
  force?: boolean;
}): void {
  setImmediate(async () => {
    try {
      await syncArccosOnce({
        limit: 1,
        force: options.force ?? true,
        userId: options.userId,
      });
    } catch (error) {
      logger.warn(
        { err: error, userId: options.userId },
        'Arccos background sync failed',
      );
    }
  });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  (async () => {
    try {
      ensureContainerRuntimeRunning();
      cleanupOrphans();
      initDatabase();
      const forceFlag = process.argv.includes('--force');
      const userArg = process.argv.find((a) => a.startsWith('--user='));
      const userId = userArg
        ? parseInt(userArg.split('=')[1] ?? '', 10)
        : undefined;
      const summary = await syncArccosOnce({ force: forceFlag, userId });
      logger.info({ summary }, 'Arccos one-shot sync done');
      process.exit(summary.failed > 0 ? 1 : 0);
    } catch (err) {
      logger.error({ err }, 'Arccos one-shot sync failed');
      process.exit(1);
    }
  })();
}
