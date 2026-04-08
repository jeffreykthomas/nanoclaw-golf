import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);
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
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

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
