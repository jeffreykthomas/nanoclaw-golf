export interface ProfileFieldSchema {
  key: string;
  type: string;
  prompt?: string;
  options?: string[];
  schema?: Record<string, string>;
}

export interface ProfileCategorySchema {
  key: string;
  label: string;
  description?: string;
  fields: ProfileFieldSchema[];
}

export interface UserProfileSchema {
  schema_name: string;
  schema_version: string;
  top_level_categories: ProfileCategorySchema[];
}

export interface ProfileFieldMeta {
  confidence: number | null;
  evidenceCount: number;
  sources: string[];
  updatedAt: string | null;
}

export type UserProfileInventory = Record<string, Record<string, unknown>>;
export type UserProfileFieldMetadata = Record<
  string,
  Record<string, ProfileFieldMeta>
>;

export type ProfileFactCategory =
  | 'identity'
  | 'demographics'
  | 'location'
  | 'work'
  | 'relationship'
  | 'hobby'
  | 'preference'
  | 'goal'
  | 'value'
  | 'priority'
  | 'strength'
  | 'weakness'
  | 'constraint'
  | 'health'
  | 'communication'
  | 'golf'
  | 'other';

export interface ProfileFact {
  id: string;
  at: string;
  source: 'user_message' | 'coach_context';
  category: ProfileFactCategory;
  fact: string;
  evidence: string;
}

export interface UserProfileDerivedSummary {
  populatedFieldCount: number;
  unknownFieldCount: number;
  categoryEvidenceCount: Record<string, number>;
  topThemes: string[];
}

export interface UserProfileDocument {
  schema_name: string;
  schema_version: string;
  user_id: string;
  updated_at: string;
  inventory: UserProfileInventory;
  field_metadata: UserProfileFieldMetadata;
  derived: UserProfileDerivedSummary;
  notes: {
    last_coach_session_id?: number;
    last_interaction_at?: string;
    last_model_update_at?: string;
    model_update_status: 'skipped' | 'updated' | 'failed';
  };
}

export interface UserProfileReport {
  userId: string;
  generatedAt: string;
  title: string;
  summary: string;
  sections: Array<{ heading: string; bullets: string[] }>;
  unknowns: string[];
}
