import fs from 'fs';

import { z } from 'zod';

import {
  AUTO_SELF_UNDERSTANDING_REPORTS_ENABLED,
  CLAW_SIBLING_TOKEN,
  COACH_APP_URL,
  COACH_FIRST_RESULT_TIMEOUT,
  SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS,
  SELF_UNDERSTANDING_REPORTS_BATCH_LIMIT,
  SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS,
  TIMEZONE,
} from './config.js';
import { runAgentTask } from './agent-task-runner.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { extractStructuredPayload } from './learning-http.js';
import { log } from './log.js';

interface ReportGroup {
  name: string;
  folder: string;
}

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

function getReportGroup(userId: number): ReportGroup {
  const folder = `self_understanding_u${userId}`;
  const groupDir = resolveGroupFolderPath(folder);
  fs.mkdirSync(groupDir, { recursive: true });

  return {
    name: `Self-Understanding ${userId}`,
    folder,
  };
}

async function synthesizeReport(
  task: PendingReportTask,
): Promise<z.infer<typeof ReportPayloadSchema>> {
  const group = getReportGroup(task.user_id);
  const result = await runAgentTask({
    folder: group.folder,
    name: group.name,
    prompt: task.prompt,
    timeoutMs: COACH_FIRST_RESULT_TIMEOUT,
    channelType: 'internal-report',
    platformId: `self-understanding:${task.user_id}`,
  });

  const structured = extractStructuredPayload(result.text);
  if (!structured) throw new Error('report_structured_payload_missing');
  const parsed = ReportPayloadSchema.safeParse(structured);
  if (!parsed.success) {
    throw new Error(`report_payload_invalid:${parsed.error.issues.map((issue) => issue.message).join(',')}`);
  }
  return parsed.data;
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
    log.warn('Self-understanding pending fetch failed', { err: error });
    summary.failed += 1;
    return summary;
  }

  if (tasks.length === 0) {
    log.info('Self-understanding pending empty');
    return summary;
  }

  for (const task of tasks) {
    summary.attempted += 1;
    const taskContext = {
      userId: task.user_id,
      sourceDigest: task.source_digest.slice(0, 10),
    };

    try {
      const report = await synthesizeReport(task);
      const result = await postReport(task, report);
      const status = (result.body.status as string) || '';

      if (result.status === 201 || status === 'created') {
        summary.created += 1;
        log.info('Report created', { ...taskContext, reportId: result.body.report_id });
      } else if (result.status === 200 && status === 'updated') {
        summary.updated += 1;
        log.info('Report updated', { ...taskContext, reportId: result.body.report_id });
      } else if (result.status === 200 && status === 'skipped') {
        summary.skipped += 1;
        log.info('Report skipped', { ...taskContext, reason: result.body.reason });
      } else if (result.status === 409 || status === 'stale') {
        summary.stale += 1;
        log.warn('Report stale on post-back', { ...taskContext, reason: result.body.reason });
      } else {
        summary.failed += 1;
        log.warn('Report post returned unexpected status', { ...taskContext, status: result.status, body: result.body });
      }
    } catch (error) {
      summary.failed += 1;
      log.warn('Report sync failed', { ...taskContext, err: error });
    }
  }

  log.info('Self-understanding sync finished', { summary });
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
    log.info('Self-understanding report loop disabled');
    return;
  }
  if (!CLAW_SIBLING_TOKEN || !COACH_APP_URL) {
    log.warn('Self-understanding report loop skipped: CLAW_SIBLING_TOKEN or COACH_APP_URL not configured');
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
        log.debug('Self-understanding loop outside allowed hours', { hour });
      } else {
        await syncSelfUnderstandingReportsOnce();
      }
    } catch (error) {
      log.warn('Self-understanding loop tick failed', { err: error });
    } finally {
      running = false;
      setTimeout(loop, SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS).unref();
    }
  };

  log.info(
    'Self-understanding report loop started',
    {
      intervalMs: SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS,
      allowedHours: SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS,
    },
  );
  void loop();
}

