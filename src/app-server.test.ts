import { describe, expect, it } from 'vitest';

import { buildPrompt } from './app-server.js';

describe('buildPrompt', () => {
  it('includes a user profile summary when available', () => {
    const prompt = buildPrompt(
      {
        requestId: 'req-1',
        transport: 'app',
        userId: 42,
        coachSessionId: 9,
        phase: 'post_round',
        message: 'Help me with my round recap.',
        context: { score: 84 },
      },
      'User values direct coaching and wants to break 80.',
    );

    expect(prompt).toContain('<user-profile-summary>');
    expect(prompt).toContain('break 80');
    expect(prompt).toContain('<context>');
  });
});
