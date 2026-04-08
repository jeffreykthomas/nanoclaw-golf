import { describe, expect, it } from 'vitest';

import type { CoachRequest } from './coach-http.js';
import { extractInsightRequests } from './coach-http.js';

describe('extractInsightRequests', () => {
  const request: CoachRequest = {
    requestId: 'req-1',
    transport: 'app',
    userId: 42,
    coachSessionId: 9,
    phase: 'post_round',
    message: 'Help me reflect on today.',
    context: {},
  };

  it('extracts valid save-insight blocks from raw output', () => {
    const results = extractInsightRequests(
      `<internal><save-insight>{"title":"Prefers direct coaching","content":"Responds best to concise next steps.","tags":["preference","communication_style"],"categorySlug":"preferences"}</save-insight></internal>`,
      request,
    );

    expect(results).toEqual([
      {
        userId: 42,
        coachSessionId: 9,
        title: 'Prefers direct coaching',
        content: 'Responds best to concise next steps.',
        tags: ['preference', 'communication_style'],
        categorySlug: 'preferences',
      },
    ]);
  });

  it('ignores malformed save-insight blocks', () => {
    const results = extractInsightRequests(
      `<internal><save-insight>not-json</save-insight></internal>`,
      request,
    );

    expect(results).toEqual([]);
  });
});
