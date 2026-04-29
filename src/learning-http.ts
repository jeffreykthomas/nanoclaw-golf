import fs from 'fs';
import http from 'http';
import path from 'path';

import { z } from 'zod';

import {
  ASSISTANT_NAME,
  CLAW_SIBLING_TOKEN,
  COACH_FIRST_RESULT_TIMEOUT,
  DATA_DIR,
} from './config.js';
import { runContainerAgent } from './container-runner.js';
import { getSession, setSession } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { RegisteredGroup } from './types.js';

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

function writeLearningIpcClose(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  } catch {
    /* ignore */
  }
}

function getLearningGroup(
  userId: number,
  learningNodeId: number,
): RegisteredGroup {
  const folder = `learning_u${userId}_n${learningNodeId}`;
  const groupDir = resolveGroupFolderPath(folder);
  fs.mkdirSync(groupDir, { recursive: true });

  return {
    name: `Learning ${userId}/${learningNodeId}`,
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };
}

function writeLearningWorkspaceFiles(
  group: RegisteredGroup,
  req: LearningRequest,
): void {
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
    req.node.breadcrumbs.length > 0
      ? req.node.breadcrumbs.map((crumb) => `- ${crumb}`).join('\n')
      : '- None',
    '',
    '## Summary',
    req.node.summary || 'None yet.',
    '',
    '## Current Note',
    req.node.bodyMarkdown || 'None yet.',
    '',
    '## Existing Related Titles',
    req.relatedTitles.length > 0
      ? req.relatedTitles.map((title) => `- ${title}`).join('\n')
      : '- None',
    '',
    '## Existing Note Titles',
    req.existingTitles.length > 0
      ? req.existingTitles.map((title) => `- ${title}`).join('\n')
      : '- None',
  ].join('\n');
  fs.writeFileSync(path.join(groupDir, 'topic.md'), `${topicContent}\n`);

  const sourcesIndex =
    req.sources.length > 0
      ? req.sources
          .map((source) => `- [${source.title}](sources/${source.id}.md)`)
          .join('\n')
      : '- No sources yet.';
  fs.writeFileSync(
    path.join(groupDir, 'sources.md'),
    `# Sources\n\n${sourcesIndex}\n`,
  );

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
      source.keyPoints.length > 0
        ? source.keyPoints.map((point) => `- ${point}`).join('\n')
        : 'No key points yet.',
      '',
      '## Extracted Content',
      source.extractedContent || 'No extracted content available.',
    ].join('\n');
    fs.writeFileSync(
      path.join(groupDir, 'sources', `${source.id}.md`),
      `${sourceContent}\n`,
    );
  }

  const childrenContent =
    req.children.length > 0
      ? req.children
          .map(
            (child) =>
              `- ${child.title}: ${child.summary || 'No summary yet.'}`,
          )
          .join('\n')
      : '- No child topics yet.';
  fs.writeFileSync(
    path.join(groupDir, 'children.md'),
    `# Child Topics\n\n${childrenContent}\n`,
  );

  if (req.question) {
    fs.writeFileSync(
      path.join(groupDir, 'question.md'),
      `# Current Question\n\n${req.question.questionText}\n`,
    );
  } else {
    fs.rmSync(path.join(groupDir, 'question.md'), { force: true });
  }
}

export function extractStructuredPayload(
  rawText: string,
): Record<string, unknown> | null {
  const cleaned = formatOutbound(rawText).trim();
  if (!cleaned) return null;

  const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() || cleaned;

  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonText = objectMatch ? objectMatch[0] : candidate;

  return JSON.parse(jsonText) as Record<string, unknown>;
}

export function buildLearningPrompt(req: LearningRequest): string {
  const sharedContext = [
    'You are an expert research assistant working inside a learning workspace.',
    'Read the files in /workspace/group for the current topic context before responding.',
    'Prefer authoritative sources and explicit uncertainty over hand-wavy filler.',
    'Return valid JSON only. Do not wrap the response in markdown fences.',
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

export async function handleLearningRequest(
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

  const requestLogger = logger.child({
    requestId: learningReq.requestId,
    taskType: learningReq.taskType,
    learningNodeId: learningReq.learningNodeId,
    userId: learningReq.userId,
  });

  try {
    const group = getLearningGroup(
      learningReq.userId,
      learningReq.learningNodeId,
    );
    writeLearningWorkspaceFiles(group, learningReq);
    const sessionId = getSession(group.folder);
    let newSessionId: string | undefined;
    let firstResultResolved = false;
    let resolveFirstResult:
      | ((value: {
          payload: Record<string, unknown>;
          rawText: string;
          newSessionId?: string;
        }) => void)
      | null = null;
    let rejectFirstResult: ((reason?: Error) => void) | null = null;
    const firstResultPromise = new Promise<{
      payload: Record<string, unknown>;
      rawText: string;
      newSessionId?: string;
    }>((resolve, reject) => {
      resolveFirstResult = resolve;
      rejectFirstResult = reject;
    });

    const outputPromise = runContainerAgent(
      group,
      {
        prompt: buildLearningPrompt(learningReq),
        sessionId,
        groupFolder: group.folder,
        chatJid: `app:learning-${learningReq.learningNodeId}`,
        isMain: false,
        assistantName: ASSISTANT_NAME,
      },
      () => {
        // No queue registration needed for synchronous HTTP
      },
      async (streamOutput) => {
        if (streamOutput.newSessionId) {
          newSessionId = streamOutput.newSessionId;
          setSession(group.folder, streamOutput.newSessionId);
        }

        if (
          !streamOutput.result ||
          firstResultResolved ||
          !resolveFirstResult
        ) {
          return;
        }

        const rawText =
          typeof streamOutput.result === 'string'
            ? streamOutput.result
            : JSON.stringify(streamOutput.result);

        try {
          const payload = extractStructuredPayload(rawText);
          if (!payload) return;

          firstResultResolved = true;
          writeLearningIpcClose(group.folder);
          resolveFirstResult({
            payload,
            rawText: formatOutbound(rawText),
            newSessionId,
          });
        } catch {
          // Ignore non-JSON chunks until the agent emits a structured answer.
        }
      },
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        writeLearningIpcClose(group.folder);
        reject(new Error('first_result_timeout'));
      }, COACH_FIRST_RESULT_TIMEOUT).unref();
    });

    outputPromise
      .then((output) => {
        if (output.newSessionId) {
          setSession(group.folder, output.newSessionId);
        }

        if (firstResultResolved || !rejectFirstResult) return;
        writeLearningIpcClose(group.folder);
        rejectFirstResult(
          new Error(output.error || 'structured_payload_parse_failed'),
        );
      })
      .catch((error) => {
        if (firstResultResolved || !rejectFirstResult) return;
        writeLearningIpcClose(group.folder);
        rejectFirstResult(
          error instanceof Error ? error : new Error(String(error)),
        );
      });

    const firstResult = await Promise.race([
      firstResultPromise,
      timeoutPromise,
    ]);

    requestLogger.info('Learning response sent');
    jsonResponse(res, 200, {
      payload: firstResult.payload,
      rawText: firstResult.rawText,
      sessionId: firstResult.newSessionId || sessionId || null,
    });
  } catch (error) {
    requestLogger.error({ error }, 'Learning request failed');
    jsonResponse(res, 500, { error: 'internal_error' });
  }
}
