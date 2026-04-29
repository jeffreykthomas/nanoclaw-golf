import fs from 'fs/promises';
import path from 'path';

import { z } from 'zod';

import type {
  ProfileCategorySchema,
  ProfileFieldMeta,
  ProfileFieldSchema,
  UserProfileFieldMetadata,
  UserProfileInventory,
  UserProfileSchema,
} from './types.js';

const fieldSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
  prompt: z.string().optional(),
  options: z.array(z.string()).optional(),
  schema: z.record(z.string(), z.string()).optional(),
});

const categorySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(fieldSchema),
});

const userProfileSchema = z.object({
  schema_name: z.string().min(1),
  schema_version: z.string().min(1),
  top_level_categories: z.array(categorySchema),
});

let cachedSchema: Promise<UserProfileSchema> | null = null;

function schemaPath(): string {
  return path.join(process.cwd(), 'profile', 'user-profile-schema.json');
}

function emptyFieldMeta(): ProfileFieldMeta {
  return {
    confidence: null,
    evidenceCount: 0,
    sources: [],
    updatedAt: null,
  };
}

export async function loadUserProfileSchema(): Promise<UserProfileSchema> {
  if (cachedSchema) return cachedSchema;
  cachedSchema = fs
    .readFile(schemaPath(), 'utf8')
    .then(
      (raw) => userProfileSchema.parse(JSON.parse(raw)) as UserProfileSchema,
    );
  return cachedSchema;
}

export function createEmptyInventory(
  schema: UserProfileSchema,
): UserProfileInventory {
  return schema.top_level_categories.reduce<UserProfileInventory>(
    (acc, category) => {
      acc[category.key] = category.fields.reduce<Record<string, unknown>>(
        (fieldAcc, field) => {
          fieldAcc[field.key] = null;
          return fieldAcc;
        },
        {},
      );
      return acc;
    },
    {},
  );
}

export function createEmptyFieldMetadata(
  schema: UserProfileSchema,
): UserProfileFieldMetadata {
  return schema.top_level_categories.reduce<UserProfileFieldMetadata>(
    (acc, category) => {
      acc[category.key] = category.fields.reduce<
        Record<string, ProfileFieldMeta>
      >((fieldAcc, field) => {
        fieldAcc[field.key] = emptyFieldMeta();
        return fieldAcc;
      }, {});
      return acc;
    },
    {},
  );
}

function normalizeObjectField(
  field: ProfileFieldSchema,
  value: unknown,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || !field.schema) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [subKey, subType] of Object.entries(field.schema)) {
    normalized[subKey] = normalizeValue(
      { key: subKey, type: subType },
      input[subKey],
    );
  }
  return normalized;
}

function normalizeListObjectField(
  field: ProfileFieldSchema,
  value: unknown,
): Array<Record<string, unknown>> | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || !field.schema) return null;
  const items = value
    .map((item) => normalizeObjectField(field, item))
    .filter((item): item is Record<string, unknown> => item !== null);
  return items.length > 0 ? items : [];
}

function normalizeStringList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return items.length > 0 ? items : [];
}

function normalizeEnum(
  field: ProfileFieldSchema,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    field.options &&
    field.options.length > 0 &&
    !field.options.includes(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function normalizeScale(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 10) return null;
  return rounded;
}

function normalizeValue(field: ProfileFieldSchema, value: unknown): unknown {
  switch (field.type) {
    case 'string':
    case 'string_optional':
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    case 'number_optional':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'list_string':
    case 'list_string_optional':
      return normalizeStringList(value);
    case 'list_object':
      return normalizeListObjectField(field, value);
    case 'object':
      return normalizeObjectField(field, value);
    case 'object_optional':
      return normalizeObjectField(field, value);
    case 'enum':
    case 'enum_short_mid_long':
      return normalizeEnum(field, value);
    case 'scale_0_10':
      return normalizeScale(value);
    default:
      return value ?? null;
  }
}

export function normalizeInventory(
  schema: UserProfileSchema,
  candidate: unknown,
  fallback?: UserProfileInventory,
): UserProfileInventory {
  const source =
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : {};
  const fallbackInventory = fallback ?? createEmptyInventory(schema);

  return schema.top_level_categories.reduce<UserProfileInventory>(
    (acc, category) => {
      const categorySource =
        source[category.key] &&
        typeof source[category.key] === 'object' &&
        !Array.isArray(source[category.key])
          ? (source[category.key] as Record<string, unknown>)
          : {};
      const categoryFallback = fallbackInventory[category.key] ?? {};

      acc[category.key] = category.fields.reduce<Record<string, unknown>>(
        (fieldAcc, field) => {
          const normalized = normalizeValue(field, categorySource[field.key]);
          fieldAcc[field.key] =
            normalized !== null && normalized !== undefined
              ? normalized
              : (categoryFallback[field.key] ?? null);
          return fieldAcc;
        },
        {},
      );
      return acc;
    },
    {},
  );
}

export function countInventoryFields(schema: UserProfileSchema): number {
  return schema.top_level_categories.reduce(
    (total, category) => total + category.fields.length,
    0,
  );
}

export function listUnknownFields(
  schema: UserProfileSchema,
  inventory: UserProfileInventory,
): string[] {
  const unknowns: string[] = [];
  for (const category of schema.top_level_categories) {
    const values = inventory[category.key] ?? {};
    for (const field of category.fields) {
      if (values[field.key] === null || values[field.key] === undefined) {
        unknowns.push(`${category.label}: ${field.key}`);
      }
    }
  }
  return unknowns;
}

export function listPopulatedFields(
  schema: UserProfileSchema,
  inventory: UserProfileInventory,
): Array<{
  category: ProfileCategorySchema;
  field: ProfileFieldSchema;
  value: unknown;
}> {
  const populated: Array<{
    category: ProfileCategorySchema;
    field: ProfileFieldSchema;
    value: unknown;
  }> = [];
  for (const category of schema.top_level_categories) {
    const values = inventory[category.key] ?? {};
    for (const field of category.fields) {
      const value = values[field.key];
      if (value !== null && value !== undefined) {
        populated.push({ category, field, value });
      }
    }
  }
  return populated;
}
