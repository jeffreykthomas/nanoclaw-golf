import { describe, expect, it } from 'vitest';

import {
  buildCompactProfileSummary,
  buildUserProfileReport,
  renderUserProfileReport,
} from './report.js';
import type {
  ProfileFact,
  UserProfileDocument,
  UserProfileSchema,
} from './types.js';

const schema: UserProfileSchema = {
  schema_name: 'test',
  schema_version: '0.1.0',
  top_level_categories: [
    {
      key: 'golf_game_coaching_profile',
      label: 'Golf',
      fields: [
        { key: 'current_golf_goals', type: 'list_string' },
        { key: 'golf_strengths', type: 'list_string' },
      ],
    },
    {
      key: 'strengths_capabilities_skills',
      label: 'Strengths',
      fields: [{ key: 'signature_strengths', type: 'list_string' }],
    },
    {
      key: 'goals_plans_obligations',
      label: 'Goals',
      fields: [
        {
          key: 'current_goals',
          type: 'list_object',
          schema: {
            goal: 'string',
            horizon: 'enum_short_mid_long',
            priority: 'scale_0_10',
          },
        },
      ],
    },
  ],
};

const profile: UserProfileDocument = {
  schema_name: 'test',
  schema_version: '0.1.0',
  user_id: '42',
  updated_at: '2026-03-26T10:00:00.000Z',
  inventory: {
    golf_game_coaching_profile: {
      current_golf_goals: ['break 80'],
      golf_strengths: ['driving distance'],
    },
    strengths_capabilities_skills: {
      signature_strengths: ['discipline'],
    },
    goals_plans_obligations: {
      current_goals: [
        { goal: 'play twice a week', horizon: 'mid', priority: 8 },
      ],
    },
  },
  field_metadata: {
    golf_game_coaching_profile: {
      current_golf_goals: {
        confidence: 0.8,
        evidenceCount: 3,
        sources: ['a'],
        updatedAt: '2026-03-26T10:00:00.000Z',
      },
      golf_strengths: {
        confidence: 0.8,
        evidenceCount: 3,
        sources: ['a'],
        updatedAt: '2026-03-26T10:00:00.000Z',
      },
    },
    strengths_capabilities_skills: {
      signature_strengths: {
        confidence: 0.7,
        evidenceCount: 2,
        sources: ['b'],
        updatedAt: '2026-03-26T10:00:00.000Z',
      },
    },
    goals_plans_obligations: {
      current_goals: {
        confidence: 0.7,
        evidenceCount: 2,
        sources: ['c'],
        updatedAt: '2026-03-26T10:00:00.000Z',
      },
    },
  },
  derived: {
    populatedFieldCount: 4,
    unknownFieldCount: 0,
    categoryEvidenceCount: {
      golf_game_coaching_profile: 3,
      strengths_capabilities_skills: 2,
      goals_plans_obligations: 2,
    },
    topThemes: ['break 80', 'discipline'],
  },
  notes: {
    model_update_status: 'updated',
  },
};

const facts: ProfileFact[] = [
  {
    id: '1',
    at: '2026-03-26T10:00:00.000Z',
    source: 'user_message',
    category: 'golf',
    fact: 'wants to break 80',
    evidence: 'I want to break 80 this year.',
  },
];

describe('profile report', () => {
  it('builds and renders a report with golf content', () => {
    const report = buildUserProfileReport({ schema, profile, facts });
    const rendered = renderUserProfileReport(report);
    const summary = buildCompactProfileSummary(report);

    expect(rendered).toContain('Golf Snapshot');
    expect(rendered).toContain('break 80');
    expect(summary).toContain('Golf remains a central thread');
  });
});
