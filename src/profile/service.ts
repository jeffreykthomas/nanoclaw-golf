import {
  markUserProfileReportGenerated,
  upsertUserProfileIndex,
} from '../db.js';
import { logger } from '../logger.js';
import { extractProfileFacts } from './facts.js';
import { maybeRunProfileModelUpdate } from './model.js';
import {
  buildCompactProfileSummary,
  buildUserProfileReport,
  renderUserProfileReport,
} from './report.js';
import {
  countInventoryFields,
  createEmptyFieldMetadata,
  createEmptyInventory,
  loadUserProfileSchema,
} from './schema.js';
import {
  appendProfileFacts,
  loadProfileFacts,
  loadUserProfileDocument,
  readCompactProfileSummary,
  readProfileReport,
  writeCompactProfileSummary,
  writeProfileReport,
  writeUserProfileDocument,
} from './store.js';
import type {
  ProfileFact,
  ProfileFactCategory,
  UserProfileDerivedSummary,
  UserProfileDocument,
  UserProfileFieldMetadata,
  UserProfileInventory,
  UserProfileSchema,
} from './types.js';

const updateChains = new Map<string, Promise<void>>();

function confidenceForSamples(samples: number): number | null {
  if (samples <= 0) return null;
  const normalized = Math.log1p(samples) / Math.log(10);
  return Number(Math.min(0.95, 0.2 + normalized * 0.75).toFixed(2));
}

function factCategoryToSchemaCategories(
  category: ProfileFactCategory,
): string[] {
  switch (category) {
    case 'demographics':
      return ['demographics_social_position'];
    case 'location':
      return ['demographics_social_position'];
    case 'work':
      return ['demographics_social_position', 'social_context_roles_norms'];
    case 'relationship':
      return [
        'social_style_relationship_patterns',
        'attachment_intimacy_boundaries',
      ];
    case 'goal':
      return ['goals_plans_obligations', 'motivations_needs_drives'];
    case 'value':
      return ['values_beliefs_ethics'];
    case 'priority':
      return ['goals_plans_obligations', 'resources_constraints_logistics'];
    case 'strength':
      return ['strengths_capabilities_skills'];
    case 'weakness':
      return ['weaknesses_limitations_flaws'];
    case 'constraint':
      return ['resources_constraints_logistics'];
    case 'health':
      return ['health_body_sensory', 'resources_constraints_logistics'];
    case 'communication':
      return [
        'communication_voice_expression',
        'conflict_power_strategy',
        'social_style_relationship_patterns',
      ];
    case 'golf':
      return ['golf_game_coaching_profile'];
    case 'hobby':
    case 'preference':
      return ['aesthetics_taste_preferences', 'habits_routines_environment'];
    case 'identity':
      return ['identity_self_concept'];
    default:
      return [];
  }
}

function buildCategoryEvidenceCount(
  schema: UserProfileSchema,
  facts: ProfileFact[],
): Record<string, number> {
  const counts = schema.top_level_categories.reduce<Record<string, number>>(
    (acc, category) => {
      acc[category.key] = 0;
      return acc;
    },
    {},
  );

  for (const fact of facts) {
    for (const categoryKey of factCategoryToSchemaCategories(fact.category)) {
      counts[categoryKey] = (counts[categoryKey] ?? 0) + 1;
    }
  }

  return counts;
}

function buildFieldMetadata(
  schema: UserProfileSchema,
  inventory: UserProfileInventory,
  facts: ProfileFact[],
  previous?: UserProfileFieldMetadata,
  updatedAt?: string,
): UserProfileFieldMetadata {
  const categoryEvidenceCount = buildCategoryEvidenceCount(schema, facts);
  const metadata = createEmptyFieldMetadata(schema);

  for (const category of schema.top_level_categories) {
    const relevantFacts = facts
      .filter((fact) =>
        factCategoryToSchemaCategories(fact.category).includes(category.key),
      )
      .slice(-5);

    for (const field of category.fields) {
      const value = inventory[category.key]?.[field.key];
      if (value === null || value === undefined) {
        metadata[category.key][field.key] =
          previous?.[category.key]?.[field.key] ??
          metadata[category.key][field.key];
        continue;
      }

      metadata[category.key][field.key] = {
        confidence:
          confidenceForSamples(categoryEvidenceCount[category.key] ?? 0) ??
          previous?.[category.key]?.[field.key]?.confidence ??
          null,
        evidenceCount:
          categoryEvidenceCount[category.key] ??
          previous?.[category.key]?.[field.key]?.evidenceCount ??
          0,
        sources:
          relevantFacts.map((fact) => fact.id) ??
          previous?.[category.key]?.[field.key]?.sources ??
          [],
        updatedAt:
          updatedAt ?? previous?.[category.key]?.[field.key]?.updatedAt ?? null,
      };
    }
  }

  return metadata;
}

function buildDerivedSummary(params: {
  schema: UserProfileSchema;
  inventory: UserProfileInventory;
  facts: ProfileFact[];
}): UserProfileDerivedSummary {
  const categoryEvidenceCount = buildCategoryEvidenceCount(
    params.schema,
    params.facts,
  );
  let populatedFieldCount = 0;
  for (const category of params.schema.top_level_categories) {
    for (const field of category.fields) {
      const value = params.inventory[category.key]?.[field.key];
      if (value !== null && value !== undefined) populatedFieldCount += 1;
    }
  }

  return {
    populatedFieldCount,
    unknownFieldCount:
      countInventoryFields(params.schema) - populatedFieldCount,
    categoryEvidenceCount,
    topThemes: params.facts.slice(-6).map((fact) => fact.fact),
  };
}

function hasMeaningfulProfileSignal(
  message: string,
  responseText: string,
  facts: ProfileFact[],
): boolean {
  return (
    facts.length > 0 ||
    message.trim().length >= 24 ||
    responseText.trim().length >= 24
  );
}

async function updateProfileInternal(params: {
  userId: string;
  coachSessionId: number;
  message: string;
  responseText: string;
  context: Record<string, unknown>;
  interactionAt?: string;
}): Promise<void> {
  const interactionAt = params.interactionAt ?? new Date().toISOString();
  const schema = await loadUserProfileSchema();
  const newFacts = extractProfileFacts({
    message: params.message,
    context: params.context,
    at: interactionAt,
  });

  if (
    !hasMeaningfulProfileSignal(params.message, params.responseText, newFacts)
  ) {
    return;
  }

  const userId = String(params.userId);
  const existing = await loadUserProfileDocument(userId);
  const existingFacts = await loadProfileFacts(userId, 200);
  const knownFactIds = new Set(existingFacts.map((fact) => fact.id));
  const appendedFacts = newFacts.filter((fact) => !knownFactIds.has(fact.id));

  if (appendedFacts.length > 0) {
    await appendProfileFacts(userId, appendedFacts);
  }

  const allFacts = [...existingFacts, ...appendedFacts].slice(-200);
  const currentInventory = existing?.inventory ?? createEmptyInventory(schema);
  const modelResult = await maybeRunProfileModelUpdate({
    schema,
    userId,
    currentInventory,
    facts: appendedFacts.length > 0 ? appendedFacts : allFacts.slice(-12),
  });

  const inventory = modelResult.inventory;
  const fieldMetadata = buildFieldMetadata(
    schema,
    inventory,
    allFacts,
    existing?.field_metadata,
    interactionAt,
  );

  const profile: UserProfileDocument = {
    schema_name: schema.schema_name,
    schema_version: schema.schema_version,
    user_id: userId,
    updated_at: interactionAt,
    inventory,
    field_metadata: fieldMetadata,
    derived: buildDerivedSummary({
      schema,
      inventory,
      facts: allFacts,
    }),
    notes: {
      last_coach_session_id: params.coachSessionId,
      last_interaction_at: interactionAt,
      last_model_update_at:
        modelResult.status === 'updated'
          ? interactionAt
          : existing?.notes.last_model_update_at,
      model_update_status: modelResult.status,
    },
  };

  const report = buildUserProfileReport({
    schema,
    profile,
    facts: allFacts,
  });
  const renderedReport = renderUserProfileReport(report);
  const compactSummary = buildCompactProfileSummary(report);

  await Promise.all([
    writeUserProfileDocument(userId, profile),
    writeProfileReport(userId, renderedReport),
    writeCompactProfileSummary(userId, compactSummary),
  ]);

  upsertUserProfileIndex({
    user_id: userId,
    coach_session_id: params.coachSessionId,
    updated_at: interactionAt,
    last_interaction_at: interactionAt,
    evidence_count: allFacts.length,
  });
}

export function queueUserProfileUpdate(params: {
  userId: string;
  coachSessionId: number;
  message: string;
  responseText: string;
  context: Record<string, unknown>;
  interactionAt?: string;
}): Promise<void> {
  const key = String(params.userId);
  const previous = updateChains.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => updateProfileInternal(params))
    .catch((error) => {
      logger.warn({ error, userId: key }, 'profile update chain failed');
    });
  updateChains.set(key, next);
  return next;
}

export function detectProfileCommand(
  message: string,
): 'report' | 'summary' | null {
  const normalized = message.trim().toLowerCase();
  if (
    /(generate|show|give me|create).*(profile|inventory).*(report|summary)/i.test(
      normalized,
    ) ||
    /(profile report|inventory report)/i.test(normalized)
  ) {
    return 'report';
  }
  if (
    /what do you know about me/i.test(normalized) ||
    /(profile summary|what have you learned about me)/i.test(normalized)
  ) {
    return 'summary';
  }
  return null;
}

export async function getProfileCommandResponse(params: {
  userId: string;
  command: 'report' | 'summary';
}): Promise<string> {
  const userId = String(params.userId);
  const [summary, report] = await Promise.all([
    readCompactProfileSummary(userId),
    readProfileReport(userId),
  ]);

  if (params.command === 'summary' && summary) {
    markUserProfileReportGenerated(userId);
    return summary;
  }

  if (report) {
    markUserProfileReportGenerated(userId);
    return report;
  }

  return 'I do not have enough profile evidence yet to generate a useful report. Keep talking with me about your golf, goals, preferences, routines, and constraints, and I will build one over time.';
}

export async function getLatestProfileSummary(
  userId: string,
): Promise<string | null> {
  return readCompactProfileSummary(String(userId));
}

function formatFactDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'recently';
  return new Date(timestamp).toISOString().slice(0, 10);
}

function compactFactText(value: string, limit = 220): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (compacted.length <= limit) return compacted;
  return `${compacted.slice(0, limit - 1).trim()}…`;
}

function renderCheckInFact(prefix: string, fact: ProfileFact): string {
  return `${prefix} (${formatFactDate(fact.at)}): ${fact.category} — ${compactFactText(fact.fact)}`;
}

export async function getLatestCheckInContext(
  userId: string,
): Promise<string | null> {
  const facts = (await loadProfileFacts(String(userId), 60)).filter(
    (fact) => fact.category !== 'other',
  );
  if (facts.length === 0) return null;

  const latest = facts.at(-1);
  const latestGolf = [...facts]
    .reverse()
    .find((fact) => ['golf', 'goal', 'priority'].includes(fact.category));

  const lines: string[] = [];
  if (latest) lines.push(renderCheckInFact('Most recent signal', latest));
  if (latestGolf && latestGolf.id !== latest?.id) {
    lines.push(renderCheckInFact('Latest golf thread', latestGolf));
  }

  return lines.join('\n');
}

export async function getUserProfileInventoryView(userId: string): Promise<{
  schema_name: string;
  schema_version: string;
  user_id: string;
  profile_exists: boolean;
  updated_at: string | null;
  counts: {
    total_fields: number;
    populated_fields: number;
    unknown_fields: number;
  };
  categories: Array<{
    key: string;
    label: string;
    description?: string;
    counts: {
      total_fields: number;
      populated_fields: number;
      unknown_fields: number;
    };
    fields: Array<{
      key: string;
      type: string;
      prompt?: string;
      options?: string[];
      schema?: Record<string, string>;
      value: unknown;
      populated: boolean;
      metadata: {
        confidence: number | null;
        evidenceCount: number;
        sources: string[];
        updatedAt: string | null;
      };
    }>;
  }>;
}> {
  const schema = await loadUserProfileSchema();
  const profile = await loadUserProfileDocument(String(userId));
  const inventory = profile?.inventory ?? createEmptyInventory(schema);
  const fieldMetadata =
    profile?.field_metadata ?? createEmptyFieldMetadata(schema);

  let populatedFields = 0;
  const categories = schema.top_level_categories.map((category) => {
    let categoryPopulatedFields = 0;
    const values = inventory[category.key] ?? {};
    const metadata = fieldMetadata[category.key] ?? {};
    const fields = category.fields.map((field) => {
      const value = values[field.key] ?? null;
      const populated = value !== null && value !== undefined;
      if (populated) {
        populatedFields += 1;
        categoryPopulatedFields += 1;
      }

      return {
        key: field.key,
        type: field.type,
        prompt: field.prompt,
        options: field.options,
        schema: field.schema,
        value,
        populated,
        metadata: metadata[field.key] ?? {
          confidence: null,
          evidenceCount: 0,
          sources: [],
          updatedAt: null,
        },
      };
    });

    return {
      key: category.key,
      label: category.label,
      description: category.description,
      counts: {
        total_fields: category.fields.length,
        populated_fields: categoryPopulatedFields,
        unknown_fields: category.fields.length - categoryPopulatedFields,
      },
      fields,
    };
  });

  const totalFields = countInventoryFields(schema);
  return {
    schema_name: schema.schema_name,
    schema_version: schema.schema_version,
    user_id: String(userId),
    profile_exists: Boolean(profile),
    updated_at: profile?.updated_at ?? null,
    counts: {
      total_fields: totalFields,
      populated_fields: populatedFields,
      unknown_fields: totalFields - populatedFields,
    },
    categories,
  };
}
