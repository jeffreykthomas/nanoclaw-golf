import { describe, expect, it } from 'vitest';

import {
  buildLearningPrompt,
  extractStructuredPayload,
  LearningRequestSchema,
} from './learning-http.js';

describe('extractStructuredPayload', () => {
  it('parses fenced json payloads', () => {
    const payload = extractStructuredPayload(
      '```json\n{"sources":[{"title":"Roman Republic"}]}\n```',
    );

    expect(payload).toEqual({
      sources: [{ title: 'Roman Republic' }],
    });
  });

  it('parses json objects with surrounding prose', () => {
    const payload = extractStructuredPayload(
      'Here is the result:\n{"summary":"Rome","child_topics":[]}\nThanks.',
    );

    expect(payload).toEqual({
      summary: 'Rome',
      child_topics: [],
    });
  });
});

describe('buildLearningPrompt', () => {
  const request = LearningRequestSchema.parse({
    requestId: 'req-1',
    transport: 'app',
    userId: 42,
    learningNodeId: 7,
    taskType: 'answer_question',
    node: {
      title: 'Ancient Rome',
      summary: 'A topic about Roman history.',
      bodyMarkdown: '## Current Understanding\n\nRome changed across eras.',
      breadcrumbs: ['History', 'Ancient Rome'],
    },
    question: {
      id: 3,
      questionText: 'Which institutions mattered most?',
    },
  });

  it('includes the task type and file-based context instructions', () => {
    const prompt = buildLearningPrompt(request);

    expect(prompt).toContain('Task: answer_question');
    expect(prompt).toContain('Read the files in /workspace/group');
    expect(prompt).toContain('Return JSON:');
  });

  it('describes end-to-end research for research_node tasks', () => {
    const request = LearningRequestSchema.parse({
      requestId: 'req-2',
      transport: 'app',
      userId: 42,
      learningNodeId: 7,
      taskType: 'research_node',
      node: {
        title: 'Quantum Physics',
        summary: '',
        bodyMarkdown: '',
        breadcrumbs: ['Science'],
      },
      sources: [],
      children: [],
      relatedTitles: [],
      existingTitles: [],
    });

    const prompt = buildLearningPrompt(request);

    expect(prompt).toContain('Task: research_node');
    expect(prompt).toContain('Research this topic end-to-end');
    expect(prompt).toContain('"summary_markdown"');
  });

  it('describes focused summarization for summarize_source tasks', () => {
    const request = LearningRequestSchema.parse({
      requestId: 'req-3',
      transport: 'app',
      userId: 42,
      learningNodeId: 7,
      taskType: 'summarize_source',
      node: {
        title: 'Quantum Physics',
        summary: '',
        bodyMarkdown: '',
        breadcrumbs: ['Science'],
      },
      sources: [
        {
          id: 1,
          title: 'Intro paper',
          url: 'https://example.com/paper',
          extractedContent: 'Wavefunctions and measurement.',
        },
      ],
    });

    const prompt = buildLearningPrompt(request);

    expect(prompt).toContain('Task: summarize_source');
    expect(prompt).toContain('Summarize the source material');
    expect(prompt).toContain('"key_points"');
  });
});
