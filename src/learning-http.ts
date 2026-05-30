import fs from 'fs';
import http from 'http';
import path from 'path';

import { z } from 'zod';

import { CLAW_SIBLING_TOKEN, COACH_FIRST_RESULT_TIMEOUT, DATA_DIR } from './config.js';
import { getAgentTaskOutput, parseOutputText, queueAgentTask, runAgentTask } from './agent-task-runner.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { log } from './log.js';

interface LearningGroup {
  name: string;
  folder: string;
}

type LearningJobStatus = 'queued' | 'running' | 'completed' | 'failed';

interface LearningJobRecord {
  id: string;
  requestId: string;
  status: LearningJobStatus;
  taskType: z.infer<typeof LearningTaskSchema>;
  learningNodeId: number;
  userId: number;
  agentGroupId: string;
  agentGroupName: string;
  agentGroupFolder: string;
  sessionId: string;
  messageId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  payload?: Record<string, unknown>;
  rawText?: string;
}

const LEARNING_JOB_TIMEOUT_MS = 35 * 60 * 1000;

const LearningTaskSchema = z.enum([
  'research_node',
  'discover_sources',
  'summarize_source',
  'compile_node',
  'answer_question',
  'rebalance_node',
]);

const LearningNodePayloadSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional().default(''),
  bodyMarkdown: z.string().optional().default(''),
  parentTitle: z.string().optional().default(''),
  breadcrumbs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const LearningSourcePayloadSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string().optional(),
  sourceType: z.string().optional(),
  qualityScore: z.number().optional(),
  publicationName: z.string().optional(),
  authorName: z.string().optional(),
  publishedOn: z.string().optional(),
  whyRelevant: z.string().optional(),
  summaryMarkdown: z.string().optional(),
  extractedContent: z.string().optional(),
  citationLabel: z.string().optional(),
  keyPoints: z.array(z.string()).default([]),
});

const LearningChildPayloadSchema = z.object({
  id: z.number().optional(),
  title: z.string(),
  summary: z.string().optional(),
});

const LearningQuestionPayloadSchema = z.object({
  id: z.number().optional(),
  questionText: z.string().min(1),
});

export const LearningRequestSchema = z.object({
  requestId: z.string(),
  transport: z.literal('app'),
  userId: z.number(),
  learningNodeId: z.number(),
  taskType: LearningTaskSchema,
  node: LearningNodePayloadSchema,
  sources: z.array(LearningSourcePayloadSchema).default([]),
  children: z.array(LearningChildPayloadSchema).default([]),
  relatedTitles: z.array(z.string()).default([]),
  existingTitles: z.array(z.string()).default([]),
  question: LearningQuestionPayloadSchema.optional(),
});

export type LearningRequest = z.infer<typeof LearningRequestSchema>;

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

function learningJobsDir(): string {
  const dir = path.join(DATA_DIR, 'app-learning-jobs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function learningJobPath(jobId: string): string {
  return path.join(learningJobsDir(), `${safeJobId(jobId)}.json`);
}

function readLearningJob(jobId: string): LearningJobRecord | null {
  try {
    return JSON.parse(fs.readFileSync(learningJobPath(jobId), 'utf8')) as LearningJobRecord;
  } catch {
    return null;
  }
}

function writeLearningJob(job: LearningJobRecord): void {
  fs.writeFileSync(learningJobPath(job.id), `${JSON.stringify(job, null, 2)}\n`);
}

function publicJob(job: LearningJobRecord): Record<string, unknown> {
  return {
    id: job.id,
    requestId: job.requestId,
    status: job.status,
    taskType: job.taskType,
    learningNodeId: job.learningNodeId,
    userId: job.userId,
    sessionId: job.sessionId,
    messageId: job.messageId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    error: job.error,
  };
}

function markLearningJobFailed(job: LearningJobRecord, error: string): LearningJobRecord {
  const now = new Date().toISOString();
  return {
    ...job,
    status: 'failed',
    error,
    failedAt: now,
    updatedAt: now,
  };
}

function ensureAuthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
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

function getLearningGroup(userId: number, learningNodeId: number): LearningGroup {
  const folder = `learning_u${userId}_n${learningNodeId}`;
  const groupDir = resolveGroupFolderPath(folder);
  fs.mkdirSync(groupDir, { recursive: true });

  return {
    name: `Learning ${userId}/${learningNodeId}`,
    folder,
  };
}

function writeLearningWorkspaceFiles(group: LearningGroup, req: LearningRequest): void {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.rmSync(path.join(groupDir, 'sources'), { recursive: true, force: true });
  fs.mkdirSync(path.join(groupDir, 'sources'), { recursive: true });

  const claudeContent = [
    '# Learning Research Workspace',
    '',
    'You are working inside a note-first learning workspace for one user topic.',
    '',
    'Rules:',
    '- Prefer high-quality sources over quick generic summaries.',
    '- Preserve citations and evidence trails.',
    '- Keep notes structured so they can compound over time.',
    '- When returning a response for the current task, return valid JSON only.',
  ].join('\n');
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), `${claudeContent}\n`);

  const topicContent = [
    `# ${req.node.title}`,
    '',
    `- task_type: ${req.taskType}`,
    `- user_id: ${req.userId}`,
    `- learning_node_id: ${req.learningNodeId}`,
    `- parent_title: ${req.node.parentTitle || 'None'}`,
    '',
    '## Breadcrumbs',
    req.node.breadcrumbs.length > 0 ? req.node.breadcrumbs.map((crumb) => `- ${crumb}`).join('\n') : '- None',
    '',
    '## Summary',
    req.node.summary || 'None yet.',
    '',
    '## Current Note',
    req.node.bodyMarkdown || 'None yet.',
    '',
    '## Existing Related Titles',
    req.relatedTitles.length > 0 ? req.relatedTitles.map((title) => `- ${title}`).join('\n') : '- None',
    '',
    '## Existing Note Titles',
    req.existingTitles.length > 0 ? req.existingTitles.map((title) => `- ${title}`).join('\n') : '- None',
  ].join('\n');
  fs.writeFileSync(path.join(groupDir, 'topic.md'), `${topicContent}\n`);

  const sourcesIndex =
    req.sources.length > 0
      ? req.sources.map((source) => `- [${source.title}](sources/${source.id}.md)`).join('\n')
      : '- No sources yet.';
  fs.writeFileSync(path.join(groupDir, 'sources.md'), `# Sources\n\n${sourcesIndex}\n`);

  for (const source of req.sources) {
    const sourceContent = [
      `# ${source.title}`,
      '',
      `- source_id: ${source.id}`,
      `- source_type: ${source.sourceType || 'unknown'}`,
      `- url: ${source.url || 'N/A'}`,
      `- quality_score: ${source.qualityScore ?? 'N/A'}`,
      `- publication_name: ${source.publicationName || 'N/A'}`,
      `- author_name: ${source.authorName || 'N/A'}`,
      `- published_on: ${source.publishedOn || 'N/A'}`,
      `- why_relevant: ${source.whyRelevant || 'N/A'}`,
      `- citation_label: ${source.citationLabel || 'N/A'}`,
      '',
      '## Summary',
      source.summaryMarkdown || 'No summary yet.',
      '',
      '## Key Points',
      source.keyPoints.length > 0 ? source.keyPoints.map((point) => `- ${point}`).join('\n') : 'No key points yet.',
      '',
      '## Extracted Content',
      source.extractedContent || 'No extracted content available.',
    ].join('\n');
    fs.writeFileSync(path.join(groupDir, 'sources', `${source.id}.md`), `${sourceContent}\n`);
  }

  const childrenContent =
    req.children.length > 0
      ? req.children.map((child) => `- ${child.title}: ${child.summary || 'No summary yet.'}`).join('\n')
      : '- No child topics yet.';
  fs.writeFileSync(path.join(groupDir, 'children.md'), `# Child Topics\n\n${childrenContent}\n`);

  if (req.question) {
    fs.writeFileSync(path.join(groupDir, 'question.md'), `# Current Question\n\n${req.question.questionText}\n`);
  } else {
    fs.rmSync(path.join(groupDir, 'question.md'), { force: true });
  }
}

export function extractStructuredPayload(rawText: string): Record<string, unknown> | null {
  const cleaned = rawText
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<save-insight>[\s\S]*?<\/save-insight>/g, '')
    .trim();
  if (!cleaned) return null;

  const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() || cleaned;

  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonText = objectMatch ? objectMatch[0] : candidate;

  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch (error) {
    const repaired = escapeUnescapedQuotesInStringField(jsonText, 'body_markdown', 'child_topics');
    if (repaired !== jsonText) {
      return JSON.parse(repaired) as Record<string, unknown>;
    }
    throw error;
  }
}

function escapeUnescapedQuotesInStringField(jsonText: string, fieldName: string, nextFieldName: string): string {
  const fieldMatch = new RegExp(`"${fieldName}"\\s*:\\s*"`).exec(jsonText);
  if (!fieldMatch) return jsonText;

  const valueStart = fieldMatch.index + fieldMatch[0].length;
  const nextFieldMatch = new RegExp(`",\\s*"${nextFieldName}"\\s*:`).exec(jsonText.slice(valueStart));
  if (!nextFieldMatch) return jsonText;

  const valueEnd = valueStart + nextFieldMatch.index;
  const originalValue = jsonText.slice(valueStart, valueEnd);
  const repairedValue = originalValue.replace(/(^|[^\\])"/g, '$1\\"');
  return `${jsonText.slice(0, valueStart)}${repairedValue}${jsonText.slice(valueEnd)}`;
}

export function buildLearningPrompt(req: LearningRequest): string {
  const sharedContext = [
    'You are an expert research assistant working inside a learning workspace.',
    'Read the files in /workspace/group for the current topic context before responding.',
    'Prefer authoritative sources and explicit uncertainty over hand-wavy filler.',
    'Return valid JSON only. Do not wrap the response in markdown fences.',
    'The response must parse with JSON.parse. Escape every double quote inside string values as \\".',
    '',
    `Topic: ${req.node.title}`,
    `Task: ${req.taskType}`,
  ].join('\n');

  switch (req.taskType) {
    case 'research_node':
      return [
        sharedContext,
        '',
        'Research this topic end-to-end using the web and the current workspace context.',
        'Find a small set of strong sources, summarize each one, and then compile the topic into an organizing note.',
        'Prefer fewer high-quality sources over many weak ones.',
        'Use an Obsidian-like note structure and a gbrain-like pattern of current understanding plus evidence trail.',
        'When writing markdown inside JSON strings, prefer single quotes for quoted phrases to avoid invalid JSON.',
        '',
        'Return JSON:',
        '{',
        '  "sources": [',
        '    {',
        '      "title": "Source title",',
        '      "url": "https://example.com",',
        '      "publication_name": "Publisher",',
        '      "author_name": "Author",',
        '      "published_on": "YYYY-MM-DD or null",',
        '      "quality_score": 1,',
        '      "why_relevant": "Why this source matters",',
        '      "summary_markdown": "Markdown source summary",',
        '      "key_points": ["point one", "point two"]',
        '    }',
        '  ],',
        '  "summary": "2-3 sentence topic summary",',
        '  "body_markdown": "Markdown note",',
        '  "child_topics": [{ "title": "Subtopic", "summary": "Why it matters" }],',
        '  "related_topics": ["Existing Topic"],',
        '  "open_questions": ["Question"]',
        '}',
      ].join('\n');
    case 'discover_sources':
      return [
        sharedContext,
        '',
        'Find high-quality sources for this topic.',
        'Favor academic, primary, institutional, reference, and strong secondary sources where appropriate.',
        'If relevant, include sources from research repositories like arXiv.',
        '',
        'Return JSON:',
        '{',
        '  "sources": [',
        '    {',
        '      "title": "Source title",',
        '      "url": "https://example.com",',
        '      "publication_name": "Publisher",',
        '      "author_name": "Author",',
        '      "published_on": "YYYY-MM-DD or null",',
        '      "quality_score": 1,',
        '      "why_relevant": "Why this is worth reading"',
        '    }',
        '  ]',
        '}',
      ].join('\n');
    case 'summarize_source':
      return [
        sharedContext,
        '',
        'Summarize the source material currently present in /workspace/group/sources/.',
        'If extracted content is present, prioritize that. Otherwise use the source metadata and URL to understand the source.',
        'Be concise but high-signal.',
        '',
        'Return JSON:',
        '{',
        '  "title": "Cleaned source title",',
        '  "summary_markdown": "Markdown summary",',
        '  "key_points": ["point one", "point two", "point three"]',
        '}',
      ].join('\n');
    case 'compile_node':
      return [
        sharedContext,
        '',
        'Compile the topic into an Obsidian-like organizing note.',
        'Use a gbrain-like shape: current understanding at the top, evidence/history below.',
        'Suggest up to 5 child topics and related existing topics when useful.',
        'Use [[Wikilinks]] where they clarify structure.',
        '',
        'Return JSON:',
        '{',
        '  "summary": "2-3 sentence summary",',
        '  "body_markdown": "Markdown note",',
        '  "child_topics": [{ "title": "Subtopic", "summary": "Why it matters" }],',
        '  "related_topics": ["Existing Topic"],',
        '  "open_questions": ["Question"]',
        '}',
      ].join('\n');
    case 'answer_question':
      return [
        sharedContext,
        '',
        `Answer the question from /workspace/group/question.md using the current note and available sources.`,
        'If the evidence is incomplete, say so.',
        '',
        'Return JSON:',
        '{',
        '  "answer_markdown": "Markdown answer",',
        '  "citations": [{ "source_id": 1, "title": "Source title", "reason": "How it supports the answer" }]',
        '}',
      ].join('\n');
    case 'rebalance_node':
      return [
        sharedContext,
        '',
        'Reorganize crowded child topics into 2-5 clearer buckets.',
        'Group by mental model, not by arbitrary superficial labels.',
        '',
        'Return JSON:',
        '{',
        '  "buckets": [',
        '    {',
        '      "title": "Bucket title",',
        '      "summary": "What belongs here",',
        '      "child_titles": ["Existing Child Title"]',
        '    }',
        '  ]',
        '}',
      ].join('\n');
    default:
      return sharedContext;
  }
}

async function respondWithLearningJobStatus(record: LearningJobRecord, res: http.ServerResponse): Promise<void> {
  let job = record;

  if (job.status === 'completed' && job.payload) {
    jsonResponse(res, 200, {
      status: job.status,
      job: publicJob(job),
      payload: job.payload,
      rawText: job.rawText,
      sessionId: job.sessionId,
    });
    return;
  }

  if (job.status === 'failed') {
    jsonResponse(res, 200, {
      status: job.status,
      job: publicJob(job),
      error: job.error,
    });
    return;
  }

  const rawMessage = getAgentTaskOutput(job.agentGroupId, job.sessionId, job.messageId);
  if (!rawMessage) {
    const elapsedMs = Date.now() - Date.parse(job.createdAt);
    if (elapsedMs > LEARNING_JOB_TIMEOUT_MS) {
      job = markLearningJobFailed(job, `learning_job_timeout:${job.messageId}`);
      writeLearningJob(job);
      log.error('Learning job timed out', {
        requestId: job.requestId,
        taskType: job.taskType,
        learningNodeId: job.learningNodeId,
        userId: job.userId,
        messageId: job.messageId,
      });
      jsonResponse(res, 200, {
        status: job.status,
        job: publicJob(job),
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
      writeLearningJob(job);
    }

    jsonResponse(res, 200, {
      status: job.status,
      job: publicJob(job),
    });
    return;
  }

  const rawText = parseOutputText(rawMessage.content);
  try {
    const payload = extractStructuredPayload(rawText);
    if (!payload) {
      throw new Error('structured_payload_parse_failed');
    }

    const now = new Date().toISOString();
    job = {
      ...job,
      status: 'completed',
      payload,
      rawText,
      completedAt: now,
      updatedAt: now,
    };
    writeLearningJob(job);
    log.info('Learning job completed', {
      requestId: job.requestId,
      taskType: job.taskType,
      learningNodeId: job.learningNodeId,
      userId: job.userId,
    });

    jsonResponse(res, 200, {
      status: job.status,
      job: publicJob(job),
      payload,
      rawText,
      sessionId: job.sessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'structured_payload_parse_failed';
    job = markLearningJobFailed(job, message);
    writeLearningJob(job);
    log.error('Learning job failed', {
      requestId: job.requestId,
      taskType: job.taskType,
      learningNodeId: job.learningNodeId,
      userId: job.userId,
      error,
    });

    jsonResponse(res, 200, {
      status: job.status,
      job: publicJob(job),
      error: job.error,
    });
  }
}

export async function handleLearningJobCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

  const parsed = LearningRequestSchema.safeParse(body);
  if (!parsed.success) {
    jsonResponse(res, 400, {
      error: 'validation_error',
      details: parsed.error.issues,
    });
    return;
  }

  const learningReq = parsed.data;
  if (learningReq.transport !== 'app') {
    jsonResponse(res, 400, { error: 'unsupported_transport' });
    return;
  }

  const existing = readLearningJob(learningReq.requestId);
  if (existing) {
    await respondWithLearningJobStatus(existing, res);
    return;
  }

  try {
    const group = getLearningGroup(learningReq.userId, learningReq.learningNodeId);
    writeLearningWorkspaceFiles(group, learningReq);

    const queued = await queueAgentTask({
      folder: group.folder,
      name: group.name,
      prompt: buildLearningPrompt(learningReq),
      timeoutMs: COACH_FIRST_RESULT_TIMEOUT,
      channelType: 'internal-learning',
      platformId: `learning:${learningReq.learningNodeId}`,
    });

    const now = new Date().toISOString();
    const job: LearningJobRecord = {
      id: learningReq.requestId,
      requestId: learningReq.requestId,
      status: 'queued',
      taskType: learningReq.taskType,
      learningNodeId: learningReq.learningNodeId,
      userId: learningReq.userId,
      agentGroupId: queued.agentGroup.id,
      agentGroupName: queued.agentGroup.name,
      agentGroupFolder: queued.agentGroup.folder,
      sessionId: queued.sessionId,
      messageId: queued.messageId,
      createdAt: now,
      updatedAt: now,
    };
    writeLearningJob(job);

    log.info('Learning job queued', {
      requestId: job.requestId,
      taskType: job.taskType,
      learningNodeId: job.learningNodeId,
      userId: job.userId,
      sessionId: job.sessionId,
      messageId: job.messageId,
    });

    jsonResponse(res, 202, {
      status: job.status,
      job: publicJob(job),
    });
  } catch (error) {
    log.error('Learning job queue failed', {
      requestId: learningReq.requestId,
      taskType: learningReq.taskType,
      learningNodeId: learningReq.learningNodeId,
      userId: learningReq.userId,
      error,
    });
    jsonResponse(res, 500, { error: 'internal_error' });
  }
}

export async function handleLearningJobStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
): Promise<void> {
  if (!ensureAuthorized(req, res)) {
    return;
  }

  const job = readLearningJob(jobId);
  if (!job) {
    jsonResponse(res, 404, { error: 'not_found' });
    return;
  }

  await respondWithLearningJobStatus(job, res);
}

export async function handleLearningRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

  const parsed = LearningRequestSchema.safeParse(body);
  if (!parsed.success) {
    jsonResponse(res, 400, {
      error: 'validation_error',
      details: parsed.error.issues,
    });
    return;
  }

  const learningReq = parsed.data;
  if (learningReq.transport !== 'app') {
    jsonResponse(res, 400, { error: 'unsupported_transport' });
    return;
  }

  const logContext = {
    requestId: learningReq.requestId,
    taskType: learningReq.taskType,
    learningNodeId: learningReq.learningNodeId,
    userId: learningReq.userId,
  };

  try {
    const group = getLearningGroup(learningReq.userId, learningReq.learningNodeId);
    writeLearningWorkspaceFiles(group, learningReq);

    const result = await runAgentTask({
      folder: group.folder,
      name: group.name,
      prompt: buildLearningPrompt(learningReq),
      timeoutMs: COACH_FIRST_RESULT_TIMEOUT,
      channelType: 'internal-learning',
      platformId: `learning:${learningReq.learningNodeId}`,
    });

    const payload = extractStructuredPayload(result.text);
    if (!payload) {
      throw new Error('structured_payload_parse_failed');
    }

    log.info('Learning response sent', logContext);
    jsonResponse(res, 200, {
      payload,
      rawText: result.text,
      sessionId: result.sessionId,
    });
  } catch (error) {
    log.error('Learning request failed', { ...logContext, error });
    jsonResponse(res, 500, { error: 'internal_error' });
  }
}
