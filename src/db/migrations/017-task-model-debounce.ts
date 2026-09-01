import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'task-model-debounce',
  up(db: Database.Database) {
    // task_model: cheaper model for task-only wakes (watchers, pipelines) so
    // the premium primary model is reserved for turns with human messages.
    db.prepare('ALTER TABLE container_configs ADD COLUMN task_model TEXT').run();
    // chat_debounce_ms: quiet window before opening a turn on bursty chat, so
    // a rapid-fire burst becomes one model turn instead of several.
    db.prepare('ALTER TABLE container_configs ADD COLUMN chat_debounce_ms INTEGER').run();
  },
};
