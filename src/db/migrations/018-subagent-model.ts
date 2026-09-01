import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'subagent-model',
  up(db: Database.Database) {
    // subagent_model: default model for Task-tool subagents, exported to the
    // container as CLAUDE_CODE_SUBAGENT_MODEL. Lets a premium orchestrator
    // (e.g. fable) delegate worker turns to a cheaper model (opus/sonnet)
    // without giving up orchestration quality.
    db.prepare('ALTER TABLE container_configs ADD COLUMN subagent_model TEXT').run();
  },
};
