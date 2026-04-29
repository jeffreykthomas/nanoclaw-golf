import { describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    AUTO_CHECKINS_ENABLED: true,
    CHECKIN_ALLOWED_HOURS: [11, 12, 17, 18, 19],
    CHECKIN_LOOP_INTERVAL_MS: 900000,
    CHECKIN_MIN_HOURS_SINCE_CHAT: 18,
    CHECKIN_MIN_HOURS_SINCE_LAST_CHECKIN: 24,
    TIMEZONE: 'UTC',
  };
});

import {
  buildCheckInMessage,
  evaluateCheckInOpportunity,
} from './checkin-engine.js';
import type { UserProfileIndex } from './types.js';

const baseProfile: UserProfileIndex = {
  user_id: '42',
  coach_session_id: 1,
  updated_at: '2026-03-26T10:00:00.000Z',
  last_report_at: null,
  last_interaction_at: '2026-03-25T15:00:00.000Z',
  last_checkin_at: null,
  evidence_count: 10,
};

describe('evaluateCheckInOpportunity', () => {
  it('sends during allowed hours after a long enough gap', () => {
    const decision = evaluateCheckInOpportunity(
      baseProfile,
      new Date('2026-03-26T17:00:00.000Z'),
    );
    expect(decision.shouldSend).toBe(true);
    expect(decision.urgency).toBe('gentle');
  });

  it('skips outside allowed hours', () => {
    const decision = evaluateCheckInOpportunity(
      baseProfile,
      new Date('2026-03-26T08:00:00.000Z'),
    );
    expect(decision.shouldSend).toBe(false);
  });

  it('skips if a recent check-in was already sent', () => {
    const decision = evaluateCheckInOpportunity(
      {
        ...baseProfile,
        last_checkin_at: '2026-03-26T01:00:00.000Z',
      },
      new Date('2026-03-26T17:00:00.000Z'),
    );
    expect(decision.shouldSend).toBe(false);
  });
});

describe('buildCheckInMessage', () => {
  it('includes summary context when available', () => {
    const message = buildCheckInMessage({
      summary: 'This profile currently has 12 populated fields.',
      urgency: 'firm',
    });
    expect(message).toContain('Quick check-in');
    expect(message).toContain('12 populated fields');
  });

  it('prefers recent context over the compact profile summary', () => {
    const message = buildCheckInMessage({
      summary:
        'This profile currently has 12 populated fields. current golf goals: compete in club championship this weekend.',
      recentContext:
        'Most recent signal (2026-04-21): golf — processed the club championship results',
      urgency: 'gentle',
    });

    expect(message).toContain('processed the club championship results');
    expect(message).not.toContain('this weekend');
  });
});
