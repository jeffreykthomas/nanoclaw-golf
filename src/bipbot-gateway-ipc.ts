import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { handleBipbotGatewayIpc } from './bipbot-gateway-host.js';
import { isValidGroupFolder } from './group-folder.js';
import { log } from './log.js';

const POLL_INTERVAL_MS = 1_000;
const IPC_ROOT = path.join(DATA_DIR, 'ipc');

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let draining = false;

function taskDirs(): Array<{ groupFolder: string; tasksDir: string }> {
  if (!fs.existsSync(IPC_ROOT)) return [];
  return fs
    .readdirSync(IPC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidGroupFolder(entry.name))
    .map((entry) => ({
      groupFolder: entry.name,
      tasksDir: path.join(IPC_ROOT, entry.name, 'tasks'),
    }))
    .filter(({ tasksDir }) => fs.existsSync(tasksDir));
}

async function processTaskFile(groupFolder: string, taskPath: string): Promise<void> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(taskPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    log.warn('Invalid BipBot gateway IPC task, removing', { groupFolder, taskPath, err });
    fs.rmSync(taskPath, { force: true });
    return;
  }

  const handled = await handleBipbotGatewayIpc(data, groupFolder, false, DATA_DIR);
  if (handled) {
    fs.rmSync(taskPath, { force: true });
  }
}

async function drainOnce(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (const { groupFolder, tasksDir } of taskDirs()) {
      const files = fs
        .readdirSync(tasksDir)
        .filter((file) => file.endsWith('.json'))
        .sort();
      for (const file of files) {
        try {
          await processTaskFile(groupFolder, path.join(tasksDir, file));
        } catch (err) {
          log.error('Failed to process BipBot gateway IPC task', {
            groupFolder,
            file,
            err,
          });
        }
      }
    }
  } finally {
    draining = false;
  }
}

function schedule(): void {
  if (stopped) return;
  timer = setTimeout(() => {
    drainOnce()
      .catch((err) => {
        log.error('BipBot gateway IPC poll failed', { err });
      })
      .finally(schedule);
  }, POLL_INTERVAL_MS);
}

export function startBipbotGatewayIpcPoller(): void {
  if (timer || draining) return;
  stopped = false;
  fs.mkdirSync(IPC_ROOT, { recursive: true });
  log.info('BipBot gateway IPC poller started', { pollIntervalMs: POLL_INTERVAL_MS });
  schedule();
}

export function stopBipbotGatewayIpcPoller(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
