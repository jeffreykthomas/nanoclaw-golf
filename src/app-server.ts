/**
 * Standalone Coach API entry point for NanoClaw.
 *
 * This remains available for compatibility, but the main NanoClaw runtime
 * can now also host the same HTTP endpoint directly.
 */

import { CLAW_SIBLING_TOKEN, ENABLE_COACH_AGENT } from './config.js';
import { startAutoCheckInLoop } from './checkin-engine.js';
import { startCoachHttpServer } from './coach-http.js';
import {
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { initDatabase } from './db.js';
import { logger } from './logger.js';
import { sendTelegramMirrorMessage } from './telegram-notifier.js';

export { buildPrompt } from './coach-http.js';

// --- Main ---

async function main(): Promise<void> {
  if (!ENABLE_COACH_AGENT) {
    logger.fatal('ENABLE_COACH_AGENT is not set to true. Exiting.');
    process.exit(1);
  }

  if (!CLAW_SIBLING_TOKEN) {
    logger.fatal('CLAW_SIBLING_TOKEN is not set. Exiting.');
    process.exit(1);
  }

  ensureContainerRuntimeRunning();
  cleanupOrphans();
  initDatabase();
  logger.info('Database initialized');

  const server = await startCoachHttpServer();
  startAutoCheckInLoop(sendTelegramMirrorMessage);

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (!server) {
      process.exit(0);
      return;
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start standalone coach API');
    process.exit(1);
  });
}
