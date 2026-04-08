import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadSenderCapabilityPolicy,
  resolveSenderCapability,
} from './sender-capability-policy.js';

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Ignore cleanup failures in tests.
    }
  }
  tempFiles.length = 0;
});

function writePolicy(contents: object): string {
  const file = path.join(
    os.tmpdir(),
    `sender-capability-policy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  tempFiles.push(file);
  return file;
}

describe('sender capability policy', () => {
  it('defaults to owner-full when no file exists', () => {
    const cfg = loadSenderCapabilityPolicy('/tmp/does-not-exist.json');
    expect(cfg.defaultProfile).toBe('owner-full');
    expect(resolveSenderCapability('tg:1', '123', cfg)).toBe('owner-full');
  });

  it('resolves per-chat sender overrides', () => {
    const file = writePolicy({
      defaultProfile: 'chat-only',
      chats: {
        'tg:mentors': {
          defaultProfile: 'operator-safe',
          senders: {
            jeff: 'owner-full',
          },
        },
      },
    });

    const cfg = loadSenderCapabilityPolicy(file);
    expect(resolveSenderCapability('tg:mentors', 'jeff', cfg)).toBe(
      'owner-full',
    );
    expect(resolveSenderCapability('tg:mentors', 'other-user', cfg)).toBe(
      'operator-safe',
    );
    expect(resolveSenderCapability('tg:golf', 'someone', cfg)).toBe(
      'chat-only',
    );
  });

  it('treats gateway-system sender as gateway-system', () => {
    const cfg = loadSenderCapabilityPolicy('/tmp/does-not-exist.json');
    expect(resolveSenderCapability('tg:1', 'gateway-system', cfg)).toBe(
      'gateway-system',
    );
  });
});
