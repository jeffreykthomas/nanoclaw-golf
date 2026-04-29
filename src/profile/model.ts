import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { normalizeInventory } from './schema.js';
import type {
  ProfileFieldSchema,
  ProfileFact,
  UserProfileInventory,
  UserProfileSchema,
} from './types.js';

type ProfileModelConfig = {
  apiKey?: string;
  authToken?: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
};

function readProfileModelConfig(): ProfileModelConfig {
  const env = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'PROFILE_MODEL',
    'PROFILE_MAX_OUTPUT_TOKENS',
  ]);

  return {
    apiKey: process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN,
    baseUrl:
      process.env.ANTHROPIC_BASE_URL ||
      env.ANTHROPIC_BASE_URL ||
      'https://api.anthropic.com',
    model:
      process.env.PROFILE_MODEL || env.PROFILE_MODEL || 'claude-sonnet-4-6',
    maxTokens: Math.max(
      1024,
      parseInt(
        process.env.PROFILE_MAX_OUTPUT_TOKENS ||
          env.PROFILE_MAX_OUTPUT_TOKENS ||
          '6000',
        10,
      ) || 6000,
    ),
  };
}

function apiEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1')
    ? `${trimmed}/messages`
    : `${trimmed}/v1/messages`;
}

function schemaToJsonType(field: ProfileFieldSchema): Record<string, unknown> {
  switch (field.type) {
    case 'string':
    case 'string_optional':
      return { type: ['string', 'null'] };
    case 'number_optional':
      return { type: ['number', 'null'] };
    case 'list_string':
    case 'list_string_optional':
      return {
        anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'string' } }],
      };
    case 'object':
    case 'object_optional':
      return {
        anyOf: [{ type: 'null' }, schemaMapToJsonSchema(field.schema ?? {})],
      };
    case 'list_object':
      return {
        anyOf: [
          { type: 'null' },
          {
            type: 'array',
            items: schemaMapToJsonSchema(field.schema ?? {}),
          },
        ],
      };
    case 'enum':
      return {
        anyOf: [
          { type: 'null' },
          { type: 'string', enum: field.options ?? [] },
        ],
      };
    case 'enum_short_mid_long':
      return {
        anyOf: [
          { type: 'null' },
          { type: 'string', enum: ['short', 'mid', 'long'] },
        ],
      };
    case 'scale_0_10':
      return {
        anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0, maximum: 10 }],
      };
    default:
      return { type: ['string', 'null'] };
  }
}

function schemaMapToJsonSchema(
  schemaMap: Record<string, string>,
): Record<string, unknown> {
  const properties = Object.entries(schemaMap).reduce<Record<string, unknown>>(
    (acc, [key, type]) => {
      acc[key] = schemaToJsonType({ key, type });
      return acc;
    },
    {},
  );

  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function buildInventoryJsonSchema(
  schema: UserProfileSchema,
): Record<string, unknown> {
  const properties = schema.top_level_categories.reduce<
    Record<string, unknown>
  >((acc, category) => {
    acc[category.key] = {
      type: 'object',
      properties: category.fields.reduce<Record<string, unknown>>(
        (fieldAcc, field) => {
          fieldAcc[field.key] = schemaToJsonType(field);
          return fieldAcc;
        },
        {},
      ),
      required: category.fields.map((field) => field.key),
      additionalProperties: false,
    };
    return acc;
  }, {});

  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function buildEvidenceBlock(facts: ProfileFact[]): string {
  if (facts.length === 0) return '(none)';
  return facts
    .slice(-60)
    .map(
      (fact) =>
        `- [${fact.category}] ${fact.fact} | source=${fact.source} | evidence=${fact.evidence}`,
    )
    .join('\n');
}

function buildPrompt(params: {
  userId: string;
  currentInventory: UserProfileInventory;
  facts: ProfileFact[];
}): string {
  return [
    `Update the structured coaching profile for user ${params.userId}.`,
    'Only fill fields that are clearly supported by the evidence.',
    'If a field is unknown, ambiguous, or only weakly implied, leave it as null.',
    'Preserve existing values unless the new evidence clearly refines them.',
    'For current goals, deadlines, "this weekend", "today", and other time-relative claims, reconcile against evidence dates. If newer evidence shows the event has happened, remove or replace the stale future-tense item.',
    'Golf is first-class: keep the golf_game_coaching_profile category up to date whenever evidence supports it.',
    'Never invent medical diagnoses, trauma narratives, or sensitive secrets without explicit evidence.',
    '',
    'CURRENT_PROFILE:',
    JSON.stringify(params.currentInventory),
    '',
    'NEW_EVIDENCE:',
    buildEvidenceBlock(params.facts),
  ].join('\n');
}

type AnthropicToolUse = {
  type: 'tool_use';
  name: string;
  input: unknown;
};

type AnthropicMessageResponse = {
  content?: Array<AnthropicToolUse | { type: string; text?: string }>;
};

export async function maybeRunProfileModelUpdate(params: {
  schema: UserProfileSchema;
  userId: string;
  currentInventory: UserProfileInventory;
  facts: ProfileFact[];
}): Promise<{
  inventory: UserProfileInventory;
  status: 'skipped' | 'updated' | 'failed';
}> {
  const config = readProfileModelConfig();
  if ((!config.apiKey && !config.authToken) || params.facts.length === 0) {
    return {
      inventory: params.currentInventory,
      status: 'skipped',
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.apiKey) headers['x-api-key'] = config.apiKey;
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;

  try {
    const response = await fetch(apiEndpoint(config.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        system:
          'You are a careful profile updater. Return exactly one tool call with the full structured profile object.',
        messages: [
          {
            role: 'user',
            content: buildPrompt(params),
          },
        ],
        tools: [
          {
            name: 'update_user_profile',
            description:
              'Return the complete updated user profile inventory using the provided schema.',
            input_schema: buildInventoryJsonSchema(params.schema),
          },
        ],
        tool_choice: {
          type: 'tool',
          name: 'update_user_profile',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`profile_model_http_${response.status}`);
    }

    const payload = (await response.json()) as AnthropicMessageResponse;
    const toolUse = payload.content?.find(
      (item): item is AnthropicToolUse =>
        item.type === 'tool_use' &&
        'name' in item &&
        item.name === 'update_user_profile',
    );
    if (!toolUse) {
      throw new Error('profile_model_missing_tool_use');
    }

    return {
      inventory: normalizeInventory(
        params.schema,
        toolUse.input,
        params.currentInventory,
      ),
      status: 'updated',
    };
  } catch (error) {
    logger.warn(
      { error },
      'profile model update failed; keeping current inventory',
    );
    return {
      inventory: params.currentInventory,
      status: 'failed',
    };
  }
}
