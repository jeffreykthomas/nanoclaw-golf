import { countInventoryFields, listUnknownFields } from './schema.js';
import type {
  ProfileFact,
  UserProfileDocument,
  UserProfileInventory,
  UserProfileReport,
  UserProfileSchema,
} from './types.js';

function toBulletText(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => toBulletText(item));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(
        ([, entry]) => entry !== null && entry !== undefined && entry !== '',
      )
      .map(
        ([key, entry]) =>
          `${key.replace(/_/g, ' ')}: ${toBulletText(entry).join(', ')}`,
      );
  }
  return [];
}

function bulletsForFields(
  inventory: UserProfileInventory,
  selections: Array<{ category: string; field: string; label?: string }>,
): string[] {
  return selections.flatMap(({ category, field, label }) => {
    const value = inventory[category]?.[field];
    const rendered = toBulletText(value);
    if (rendered.length === 0) return [];
    return rendered.map((entry) =>
      label ? `${label}: ${entry}` : `${field.replace(/_/g, ' ')}: ${entry}`,
    );
  });
}

function golfBullets(
  inventory: UserProfileInventory,
  facts: ProfileFact[],
): string[] {
  const selections = bulletsForFields(inventory, [
    {
      category: 'golf_game_coaching_profile',
      field: 'golf_identity',
      label: 'golf identity',
    },
    {
      category: 'golf_game_coaching_profile',
      field: 'current_golf_goals',
      label: 'current golf goals',
    },
    {
      category: 'golf_game_coaching_profile',
      field: 'golf_strengths',
      label: 'golf strengths',
    },
    {
      category: 'golf_game_coaching_profile',
      field: 'golf_weaknesses',
      label: 'golf weaknesses',
    },
    {
      category: 'golf_game_coaching_profile',
      field: 'mental_game_patterns',
      label: 'mental game patterns',
    },
    {
      category: 'golf_game_coaching_profile',
      field: 'time_constraints_for_golf',
      label: 'time constraints for golf',
    },
    {
      category: 'golf_game_coaching_profile',
      field: 'preferred_coaching_style',
      label: 'preferred coaching style',
    },
  ]);

  const golfFacts = facts
    .filter((fact) => fact.category === 'golf')
    .slice(-4)
    .map((fact) => `recent golf evidence: ${fact.fact}`);
  return [...selections, ...golfFacts];
}

function topThemes(doc: UserProfileDocument, facts: ProfileFact[]): string[] {
  const themes = [
    ...bulletsForFields(doc.inventory, [
      {
        category: 'goals_plans_obligations',
        field: 'current_goals',
      },
      {
        category: 'values_beliefs_ethics',
        field: 'core_values',
      },
      {
        category: 'strengths_capabilities_skills',
        field: 'signature_strengths',
      },
      {
        category: 'weaknesses_limitations_flaws',
        field: 'core_flaws',
      },
    ]),
    ...facts.slice(-3).map((fact) => fact.fact),
  ];

  return themes.slice(0, 6);
}

function summaryText(
  schema: UserProfileSchema,
  doc: UserProfileDocument,
  facts: ProfileFact[],
): string {
  const totalFields = countInventoryFields(schema);
  const golf = golfBullets(doc.inventory, facts);
  const themes = topThemes(doc, facts);
  return [
    `This profile currently has ${doc.derived.populatedFieldCount} populated fields out of ${totalFields}.`,
    golf.length > 0
      ? `Golf remains a central thread: ${golf.slice(0, 2).join('; ')}.`
      : 'Golf-specific evidence is still sparse and should keep being gathered.',
    themes.length > 0
      ? `Top themes so far: ${themes.slice(0, 3).join('; ')}.`
      : 'The profile is still early and needs more varied evidence.',
  ].join(' ');
}

export function buildUserProfileReport(params: {
  schema: UserProfileSchema;
  profile: UserProfileDocument;
  facts: ProfileFact[];
}): UserProfileReport {
  const unknowns = listUnknownFields(
    params.schema,
    params.profile.inventory,
  ).slice(0, 12);
  const sections: UserProfileReport['sections'] = [
    {
      heading: 'Golf Snapshot',
      bullets: golfBullets(params.profile.inventory, params.facts),
    },
    {
      heading: 'Preferences And Lifestyle',
      bullets: bulletsForFields(params.profile.inventory, [
        {
          category: 'aesthetics_taste_preferences',
          field: 'hobbies_play',
          label: 'hobbies',
        },
        {
          category: 'aesthetics_taste_preferences',
          field: 'food_preferences',
          label: 'food preferences',
        },
        {
          category: 'aesthetics_taste_preferences',
          field: 'pet_peeves',
          label: 'pet peeves',
        },
        {
          category: 'habits_routines_environment',
          field: 'daily_routines',
          label: 'daily routines',
        },
        {
          category: 'habits_routines_environment',
          field: 'environmental_preferences',
          label: 'environmental preferences',
        },
      ]),
    },
    {
      heading: 'Strengths And Friction',
      bullets: bulletsForFields(params.profile.inventory, [
        {
          category: 'strengths_capabilities_skills',
          field: 'signature_strengths',
          label: 'signature strengths',
        },
        {
          category: 'strengths_capabilities_skills',
          field: 'soft_skills',
          label: 'soft skills',
        },
        {
          category: 'weaknesses_limitations_flaws',
          field: 'core_flaws',
          label: 'core flaws',
        },
        {
          category: 'weaknesses_limitations_flaws',
          field: 'self_sabotage_patterns',
          label: 'self sabotage patterns',
        },
        {
          category: 'resources_constraints_logistics',
          field: 'time_budget',
          label: 'time budget',
        },
        {
          category: 'resources_constraints_logistics',
          field: 'dependents_responsibilities',
          label: 'responsibilities',
        },
      ]),
    },
    {
      heading: 'Goals Priorities And Coaching Levers',
      bullets: bulletsForFields(params.profile.inventory, [
        {
          category: 'goals_plans_obligations',
          field: 'current_goals',
          label: 'current goals',
        },
        {
          category: 'goals_plans_obligations',
          field: 'blocked_goals',
          label: 'blocked goals',
        },
        {
          category: 'motivations_needs_drives',
          field: 'primary_goals_long_horizon',
          label: 'long horizon goals',
        },
        {
          category: 'values_beliefs_ethics',
          field: 'core_values',
          label: 'core values',
        },
        {
          category: 'communication_voice_expression',
          field: 'directness',
          label: 'communication directness',
        },
        {
          category: 'conflict_power_strategy',
          field: 'conflict_style',
          label: 'conflict style',
        },
      ]),
    },
  ];

  return {
    userId: params.profile.user_id,
    generatedAt: new Date().toISOString(),
    title: 'Coaching Profile Report',
    summary: summaryText(params.schema, params.profile, params.facts),
    sections: sections.filter((section) => section.bullets.length > 0),
    unknowns,
  };
}

export function renderUserProfileReport(report: UserProfileReport): string {
  const lines: string[] = [
    report.title,
    `Generated: ${report.generatedAt}`,
    '',
    report.summary,
  ];

  for (const section of report.sections) {
    lines.push('', section.heading);
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
  }

  if (report.unknowns.length > 0) {
    lines.push('', 'Still Unclear');
    for (const unknown of report.unknowns) {
      lines.push(`- ${unknown}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function buildCompactProfileSummary(report: UserProfileReport): string {
  const sectionBullets = report.sections.flatMap((section) =>
    section.bullets.slice(0, section.heading === 'Golf Snapshot' ? 3 : 2),
  );
  const lines = [
    report.summary,
    ...sectionBullets.slice(0, 8).map((bullet) => `- ${bullet}`),
  ];
  return lines.join('\n').slice(0, 1800).trim();
}
