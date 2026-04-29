import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here. They stay on disk until explicitly loaded by the
// container runner for the few workflows that still need host-managed secrets.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
]);
const coachEnvConfig = readEnvFile([
  'CLAW_SIBLING_TOKEN',
  'COACH_APP_URL',
  'ENABLE_COACH_AGENT',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKENS',
  'TELEGRAM_MIRROR_CHAT_ID',
  'AUTO_CHECKINS_ENABLED',
  'CHECKIN_LOOP_INTERVAL_MS',
  'CHECKIN_MIN_HOURS_SINCE_CHAT',
  'CHECKIN_MIN_HOURS_SINCE_LAST_CHECKIN',
  'CHECKIN_ALLOWED_HOURS',
  'BIPBOT_GATEWAY_URL',
  'BIPBOT_GATEWAY_TOKEN',
  'BIPBOT_FIREBASE_SERVICE_ACCOUNT_PATH',
  'BIPBOT_INGRESS_POLL_INTERVAL',
  'BIPBOT_INGRESS_CHAT_JID',
  'AUTO_SELF_UNDERSTANDING_REPORTS_ENABLED',
  'SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS',
  'SELF_UNDERSTANDING_REPORTS_BATCH_LIMIT',
  'SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS',
  'AUTO_ARCCOS_SYNC_ENABLED',
  'ARCCOS_SYNC_LOOP_INTERVAL_MS',
  'ARCCOS_SYNC_BATCH_LIMIT',
  'ARCCOS_SYNC_ALLOWED_HOURS',
  'ARCCOS_SYNC_ALLOWED_WEEKDAYS',
  'ARCCOS_SYNC_CUTOFF_MONTHS',
  'ARCCOS_SYNC_MAX_ROUNDS',
  'ARCCOS_SYNC_TIMEOUT_MS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const SENDER_CAPABILITY_POLICY_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-capability-policy.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL || '';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// Coach API (app-server entry point)
export const APP_PORT = parseInt(process.env.APP_PORT || '3100', 10);
export const COACH_FIRST_RESULT_TIMEOUT = parseInt(
  process.env.COACH_FIRST_RESULT_TIMEOUT || '180000',
  10,
);
export const CLAW_SIBLING_TOKEN =
  process.env.CLAW_SIBLING_TOKEN || coachEnvConfig.CLAW_SIBLING_TOKEN || '';
export const COACH_APP_URL =
  process.env.COACH_APP_URL ||
  coachEnvConfig.COACH_APP_URL ||
  'http://127.0.0.1:3000';
export const ENABLE_COACH_AGENT =
  (process.env.ENABLE_COACH_AGENT || coachEnvConfig.ENABLE_COACH_AGENT) ===
  'true';
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || coachEnvConfig.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_BOT_TOKENS =
  process.env.TELEGRAM_BOT_TOKENS || coachEnvConfig.TELEGRAM_BOT_TOKENS || '';
export const TELEGRAM_MIRROR_CHAT_ID =
  process.env.TELEGRAM_MIRROR_CHAT_ID ||
  coachEnvConfig.TELEGRAM_MIRROR_CHAT_ID ||
  '';
export const AUTO_CHECKINS_ENABLED =
  (process.env.AUTO_CHECKINS_ENABLED ||
    coachEnvConfig.AUTO_CHECKINS_ENABLED ||
    'false') === 'true';
export const CHECKIN_LOOP_INTERVAL_MS = parseInt(
  process.env.CHECKIN_LOOP_INTERVAL_MS ||
    coachEnvConfig.CHECKIN_LOOP_INTERVAL_MS ||
    '900000',
  10,
);
export const CHECKIN_MIN_HOURS_SINCE_CHAT = parseFloat(
  process.env.CHECKIN_MIN_HOURS_SINCE_CHAT ||
    coachEnvConfig.CHECKIN_MIN_HOURS_SINCE_CHAT ||
    '18',
);
export const CHECKIN_MIN_HOURS_SINCE_LAST_CHECKIN = parseFloat(
  process.env.CHECKIN_MIN_HOURS_SINCE_LAST_CHECKIN ||
    coachEnvConfig.CHECKIN_MIN_HOURS_SINCE_LAST_CHECKIN ||
    '24',
);
export const CHECKIN_ALLOWED_HOURS = (
  process.env.CHECKIN_ALLOWED_HOURS ||
  coachEnvConfig.CHECKIN_ALLOWED_HOURS ||
  '11,12,17,18,19'
)
  .split(',')
  .map((value) => parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value >= 0 && value <= 23);

export const BIPBOT_GATEWAY_URL =
  process.env.BIPBOT_GATEWAY_URL || coachEnvConfig.BIPBOT_GATEWAY_URL || '';
export const BIPBOT_GATEWAY_TOKEN =
  process.env.BIPBOT_GATEWAY_TOKEN || coachEnvConfig.BIPBOT_GATEWAY_TOKEN || '';
export const BIPBOT_FIREBASE_SERVICE_ACCOUNT_PATH =
  process.env.BIPBOT_FIREBASE_SERVICE_ACCOUNT_PATH ||
  coachEnvConfig.BIPBOT_FIREBASE_SERVICE_ACCOUNT_PATH ||
  '';
export const BIPBOT_INGRESS_POLL_INTERVAL = parseInt(
  process.env.BIPBOT_INGRESS_POLL_INTERVAL ||
    coachEnvConfig.BIPBOT_INGRESS_POLL_INTERVAL ||
    '10000',
  10,
);
export const BIPBOT_INGRESS_CHAT_JID =
  process.env.BIPBOT_INGRESS_CHAT_JID ||
  coachEnvConfig.BIPBOT_INGRESS_CHAT_JID ||
  '';

export const AUTO_SELF_UNDERSTANDING_REPORTS_ENABLED =
  (process.env.AUTO_SELF_UNDERSTANDING_REPORTS_ENABLED ||
    coachEnvConfig.AUTO_SELF_UNDERSTANDING_REPORTS_ENABLED ||
    'false') === 'true';
export const SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS = parseInt(
  process.env.SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS ||
    coachEnvConfig.SELF_UNDERSTANDING_REPORTS_LOOP_INTERVAL_MS ||
    '3600000',
  10,
);
export const SELF_UNDERSTANDING_REPORTS_BATCH_LIMIT = parseInt(
  process.env.SELF_UNDERSTANDING_REPORTS_BATCH_LIMIT ||
    coachEnvConfig.SELF_UNDERSTANDING_REPORTS_BATCH_LIMIT ||
    '5',
  10,
);
export const SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS = (
  process.env.SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS ||
  coachEnvConfig.SELF_UNDERSTANDING_REPORTS_ALLOWED_HOURS ||
  '2'
)
  .split(',')
  .map((value) => parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value >= 0 && value <= 23);

// ---------------- Arccos sync ----------------

export const AUTO_ARCCOS_SYNC_ENABLED =
  (process.env.AUTO_ARCCOS_SYNC_ENABLED ||
    coachEnvConfig.AUTO_ARCCOS_SYNC_ENABLED ||
    'false') === 'true';

// Default: check once per hour; real work only happens if a user is due for a
// weekly sync (gated by Rails `stale_after`).
export const ARCCOS_SYNC_LOOP_INTERVAL_MS = parseInt(
  process.env.ARCCOS_SYNC_LOOP_INTERVAL_MS ||
    coachEnvConfig.ARCCOS_SYNC_LOOP_INTERVAL_MS ||
    '3600000',
  10,
);

export const ARCCOS_SYNC_BATCH_LIMIT = parseInt(
  process.env.ARCCOS_SYNC_BATCH_LIMIT ||
    coachEnvConfig.ARCCOS_SYNC_BATCH_LIMIT ||
    '3',
  10,
);

// Hour-of-day gating (local timezone). Default: 3 AM.
export const ARCCOS_SYNC_ALLOWED_HOURS = (
  process.env.ARCCOS_SYNC_ALLOWED_HOURS ||
  coachEnvConfig.ARCCOS_SYNC_ALLOWED_HOURS ||
  '3'
)
  .split(',')
  .map((value) => parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value >= 0 && value <= 23);

// Day-of-week gating (0=Sun..6=Sat). Default: Monday only → truly weekly.
export const ARCCOS_SYNC_ALLOWED_WEEKDAYS = (
  process.env.ARCCOS_SYNC_ALLOWED_WEEKDAYS ||
  coachEnvConfig.ARCCOS_SYNC_ALLOWED_WEEKDAYS ||
  '1'
)
  .split(',')
  .map((value) => parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

export const ARCCOS_SYNC_CUTOFF_MONTHS = parseInt(
  process.env.ARCCOS_SYNC_CUTOFF_MONTHS ||
    coachEnvConfig.ARCCOS_SYNC_CUTOFF_MONTHS ||
    '6',
  10,
);

export const ARCCOS_SYNC_MAX_ROUNDS = parseInt(
  process.env.ARCCOS_SYNC_MAX_ROUNDS ||
    coachEnvConfig.ARCCOS_SYNC_MAX_ROUNDS ||
    '150',
  10,
);

// Agent runtime cap per user (ms). API phase: 1-3 min. SG scrape (Phase B):
// 2-5 min across 4-6 pages. 15 min ceiling covers a first run with expired
// access key (forcing a full browser login + SG scrape).
export const ARCCOS_SYNC_TIMEOUT_MS = parseInt(
  process.env.ARCCOS_SYNC_TIMEOUT_MS ||
    coachEnvConfig.ARCCOS_SYNC_TIMEOUT_MS ||
    '900000',
  10,
);
