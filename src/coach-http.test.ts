import { describe, expect, it } from 'vitest';

import { buildPrompt, extractResearchProposals, type CoachRequest } from './coach-http.js';

const request: CoachRequest = {
  requestId: 'req-1',
  transport: 'app',
  userId: 42,
  coachSessionId: 9,
  phase: 'post_round',
  message: 'Help me with my round recap.',
  context: { score: 84 },
};

describe('buildPrompt', () => {
  it('includes a user profile summary when available', () => {
    const prompt = buildPrompt(request, 'User values direct coaching and wants to break 80.');

    expect(prompt).toContain('<user-profile-summary>');
    expect(prompt).toContain('break 80');
    expect(prompt).toContain('<context>');
  });

  it('includes recent profile context when available', () => {
    const prompt = buildPrompt(
      { ...request, message: 'What should I focus on?', context: {} },
      'Current goal: club championship this weekend.',
      'Most recent signal (2026-04-21): golf - processed the club championship results',
    );

    expect(prompt).toContain('<recent-profile-context>');
    expect(prompt).toContain('processed the club championship results');
  });

  it('separates recent conversation history from generic context', () => {
    const prompt = buildPrompt({
      ...request,
      context: {
        score: 84,
        recent_messages: [
          { role: 'user', content: 'The club championship already happened.', created_at: '2026-04-28T12:00:00Z' },
          {
            role: 'assistant',
            content: 'Let us shift to recovery and next practice.',
            created_at: '2026-04-28T12:01:00Z',
          },
        ],
      },
    });

    expect(prompt).toContain('<conversation-history>');
    expect(prompt).toContain('club championship already happened');
    expect(prompt).toContain('<context>{&quot;score&quot;:84}</context>');
    expect(prompt).toContain('Treat long-term profile summaries as background memory');
  });

  it('uses life-mode framing and suppresses golf profile memory for non-golf requests', () => {
    const prompt = buildPrompt(
      {
        ...request,
        message: 'I was referring to potentially spiritual practices.',
        context: {
          app_mode: 'life',
          controller: 'self_understanding_reports',
          path: '/self_understanding_report',
        },
      },
      'Golf remains a central thread: current golf goals are tournament prep.',
      'Most recent signal (2026-04-28): health - family schedule shifted.\nLatest golf thread (2026-04-21): golf - tournament prep.',
    );

    expect(prompt).toContain('personal coach inside Life Mode');
    expect(prompt).toContain('Do not steer the answer toward golf');
    expect(prompt).not.toContain('<user-profile-summary>');
    expect(prompt).toContain('family schedule shifted');
    expect(prompt).not.toContain('Latest golf thread');
  });

  it('does not treat negated golf mentions in Life Mode as a golf request', () => {
    const prompt = buildPrompt(
      {
        ...request,
        message: 'I mean spiritual practices, not golf.',
        context: {
          app_mode: 'life',
          controller: 'self_understanding_reports',
          path: '/self_understanding_report',
        },
      },
      'Golf remains a central thread.',
    );

    expect(prompt).toContain('personal coach inside Life Mode');
    expect(prompt).not.toContain('<user-profile-summary>');
  });

  it('instructs the agent to emit hidden research proposals', () => {
    const prompt = buildPrompt(request);

    expect(prompt).toContain('Research proposal behavior');
    expect(prompt).toContain('<research-proposals>');
    expect(prompt).toContain('Perplexity-backed learning research pipeline');
  });
});

describe('extractResearchProposals', () => {
  it('strips hidden proposals from user-facing text', () => {
    const result = extractResearchProposals(
      [
        'Short visible reply.',
        '<research-proposals>{"proposals":[{"title":"Putting Practice Evidence","summary":"Compare routines","prompt":"Research evidence-backed putting practice routines","targetNodeTitle":"Putting Practice","relatedTitles":["Practice Design"]}]}</research-proposals>',
      ].join('\n'),
    );

    expect(result.text).toBe('Short visible reply.');
    expect(result.researchProposals).toEqual([
      {
        title: 'Putting Practice Evidence',
        summary: 'Compare routines',
        prompt: 'Research evidence-backed putting practice routines',
        targetNodeTitle: 'Putting Practice',
        relatedTitles: ['Practice Design'],
        artifactKind: 'research',
      },
    ]);
  });
});
