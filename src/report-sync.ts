import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import {
  ASSISTANT_NAME,
  AUTO_SELF_UNDERSTANDING_REPORTS_ENABLED,
  CLAW_SIBLING_TOKEN,
  COACH_APP_URL,
  COACH_FIRST_RESULT_TIMEOUT,
  DATA_DIR,
  SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS,
  SELF_UNDERSTANDING_REPORTS_BATCH_LIMIT,
  SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS,
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

const PendingTaskSchema = z.object({
  user_id: z.number(),
  source_digest: z.string().min(1),
  prompt: z.string().min(1),
  framework_name: z.string().optional(),
  current_order: z.array(z.string()).optional(),
  source_updated_at: z.string().optional(),
});

const PendingResponseSchema = z.object({
  tasks: z.array(PendingTaskSchema).default([]),
});

const CurrentSchema = z.object({
  name: z.string().min(1),
  score: z.number().int().min(1).max(10),
  summary: z.string().optional().default(''),
  signals: z.array(z.string()).default([]),
});

const ReportPayloadSchema = z.object({
  title: z.string().optional().default(''),
  body_markdown: z.string().optional().default(''),
  currents: z.array(CurrentSchema).default([]),
});

export type PendingReportTask = z.infer<typeof PendingTaskSchema>;

function buildRailsUrl(path: string): URL {
  const base = COACH_APP_URL.endsWith('/')
    ? COACH_APP_URL
    : `${COACH_APP_URL}/`;
  return new URL(path.replace(/^\//, ''), base);
}

async function fetchPendingTasks(limit: number): Promise<PendingReportTask[]> {
  const url = buildRailsUrl('internal/self_understanding_reports/pending');
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${CLAW_SIBLING_TOKEN}`,
      Accept: 'application/json',
    },
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `pending_fetch_failed_${response.status}:${bodyText.slice(0, 200)}`,
    );
  }

  const parsed = PendingResponseSchema.safeParse(
    bodyText ? JSON.parse(bodyText) : { tasks: [] },
  );
  if (!parsed.success) {
    throw new Error(
      `pending_parse_failed:${parsed.error.issues.map((i) => i.message).join(',')}`,
    );
  }
  return parsed.data.tasks;
}

function writeReportIpcClose(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  } catch {
    /* ignore */
  }
}

function getReportGroup(userId: number): RegisteredGroup {
  const folder = `self_understanding_u${userId}`;
  const groupDir = resolveGroupFolderPath(folder);
  fs.mkdirSync(groupDir, { recursive: true });

  return {
    name: `Self-Understanding ${userId}`,
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };
}

async function synthesizeReport(
  task: PendingReportTask,
): Promise<z.infer<typeof ReportPayloadSchema>> {
  const group = getReportGroup(task.user_id);
  const sessionId = getSession(group.folder);
  let newSessionId: string | undefined;

  let firstResultResolved = false;
  let resolveFirstResult:
    | ((value: z.infer<typeof ReportPayloadSchema>) => void)
    | null = null;
  let rejectFirstResult: ((reason?: Error) => void) | null = null;

  const firstResultPromise = new Promise<z.infer<typeof ReportPayloadSchema>>(
    (resolve, reject) => {
      resolveFirstResult = resolve;
      rejectFirstResult = reject;
    },
  );

  const outputPromise = runContainerAgent(
    group,
    {
      prompt: task.prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: `app:self-understanding-${task.user_id}`,
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
        const parsed = ReportPayloadSchema.safeParse(structured);
        if (!parsed.success) return;

        firstResultResolved = true;
        writeReportIpcClose(group.folder);
        resolveFirstResult(parsed.data);
      } catch {
        // Keep waiting; agent may emit non-JSON progress chunks first.
      }
    },
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      writeReportIpcClose(group.folder);
      reject(new Error('report_synthesis_timeout'));
    }, COACH_FIRST_RESULT_TIMEOUT).unref();
  });

  outputPromise
    .then((output) => {
      if (output.newSessionId) {
        setSession(group.folder, output.newSessionId);
      }
      if (firstResultResolved || !rejectFirstResult) return;
      writeReportIpcClose(group.folder);
      rejectFirstResult(
        new Error(output.error || 'report_structured_payload_missing'),
      );
    })
    .catch((error) => {
      if (firstResultResolved || !rejectFirstResult) return;
      writeReportIpcClose(group.folder);
      rejectFirstResult(
        error instanceof Error ? error : new Error(String(error)),
      );
    });

  const report = await Promise.race([firstResultPromise, timeoutPromise]);
  void newSessionId;
  return report;
}

async function postReport(
  task: PendingReportTask,
  report: z.infer<typeof ReportPayloadSchema>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = buildRailsUrl('internal/self_understanding_reports');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLAW_SIBLING_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: task.user_id,
      source_digest: task.source_digest,
      report,
    }),
  });

  const bodyText = await response.text();
  let body: Record<string, unknown> = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = { raw: bodyText.slice(0, 500) };
    }
  }

  return { status: response.status, body };
}

export interface SyncSummary {
  attempted: number;
  created: number;
  updated: number;
  stale: number;
  skipped: number;
  failed: number;
}

export async function syncSelfUnderstandingReportsOnce(options?: {
  limit?: number;
}): Promise<SyncSummary> {
  const limit = Math.max(
    1,
    Math.min(options?.limit ?? SELF_UNDERSTANDING_REPORTS_BATCH_LIMIT, 25),
  );
  const summary: SyncSummary = {
    attempted: 0,
    created: 0,
    updated: 0,
    stale: 0,
    skipped: 0,
    failed: 0,
  };

  let tasks: PendingReportTask[] = [];
  try {
    tasks = await fetchPendingTasks(limit);
  } catch (error) {
    logger.warn({ err: error }, 'Self-understanding pending fetch failed');
    summary.failed += 1;
    return summary;
  }

  if (tasks.length === 0) {
    logger.info('Self-understanding pending empty');
    return summary;
  }

  for (const task of tasks) {
    summary.attempted += 1;
    const taskLogger = logger.child({
      userId: task.user_id,
      sourceDigest: task.source_digest.slice(0, 10),
    });

    try {
      const report = await synthesizeReport(task);
      const result = await postReport(task, report);
      const status = (result.body.status as string) || '';

      if (result.status === 201 || status === 'created') {
        summary.created += 1;
        taskLogger.info({ reportId: result.body.report_id }, 'Report created');
      } else if (result.status === 200 && status === 'updated') {
        summary.updated += 1;
        taskLogger.info({ reportId: result.body.report_id }, 'Report updated');
      } else if (result.status === 200 && status === 'skipped') {
        summary.skipped += 1;
        taskLogger.info({ reason: result.body.reason }, 'Report skipped');
      } else if (result.status === 409 || status === 'stale') {
        summary.stale += 1;
        taskLogger.warn(
          { reason: result.body.reason },
          'Report stale on post-back',
        );
      } else {
        summary.failed += 1;
        taskLogger.warn(
          { status: result.status, body: result.body },
          'Report post returned unexpected status',
        );
      }
    } catch (error) {
      summary.failed += 1;
      taskLogger.warn({ err: error }, 'Report sync failed');
    }
  }

  logger.info({ summary }, 'Self-understanding sync finished');
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

export function startSelfUnderstandingReportsLoop(): void {
  if (!AUTO_SELF_UNDERSTANDING_REPORTS_ENABLED) {
    logger.info('Self-understanding report loop disabled');
    return;
  }
  if (!CLAW_SIBLING_TOKEN || !COACH_APP_URL) {
    logger.warn(
      'Self-understanding report loop skipped: CLAW_SIBLING_TOKEN or COACH_APP_URL not configured',
    );
    return;
  }

  let running = false;

  const loop = async () => {
    if (running) {
      setTimeout(loop, SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS).unref();
      return;
    }
    running = true;
    try {
      const hour = currentHourInTimezone(new Date());
      if (
        SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS.length > 0 &&
        !SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS.includes(hour)
      ) {
        logger.debug({ hour }, 'Self-understanding loop outside allowed hours');
      } else {
        await syncSelfUnderstandingReportsOnce();
      }
    } catch (error) {
      logger.warn({ err: error }, 'Self-understanding loop tick failed');
    } finally {
      running = false;
      setTimeout(loop, SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS).unref();
    }
  };

  logger.info(
    {
      intervalMs: SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS,
      allowedHours: SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS,
    },
    'Self-understanding report loop started',
  );
  void loop();
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
      const summary = await syncSelfUnderstandingReportsOnce();
      logger.info({ summary }, 'Self-understanding one-shot sync done');
      process.exit(summary.failed > 0 ? 1 : 0);
    } catch (err) {
      logger.error({ err }, 'Self-understanding one-shot sync failed');
      process.exit(1);
    }
  })();
}
