import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ClaudeProvider, digestTranscriptMessages, isCompactNoiseContent } from './claude.js';

// maybeRotateContinuation guards the cold-resume failure mode: a long-lived
// session whose on-disk transcript has grown so large (or old) that the SDK
// can't reload it before the host's idle ceiling kills the container.

let tmp: string;
let prevHome: string | undefined;
let prevConv: string | undefined;
let prevBytes: string | undefined;
let prevDays: string | undefined;

const PROJECT_DIR = '-workspace-agent';
const CWD = '/workspace/agent';

function writeTranscript(sessionId: string, bytes: number, firstTs?: string): string {
  const dir = path.join(tmp, '.claude', 'projects', PROJECT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  const first =
    JSON.stringify({
      type: 'user',
      timestamp: firstTs ?? new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    }) + '\n';
  const filler = 'x'.repeat(Math.max(0, bytes - first.length));
  fs.writeFileSync(p, first + filler);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rotate-'));
  prevHome = process.env.HOME;
  prevConv = process.env.NANOCLAW_CONVERSATIONS_DIR;
  prevBytes = process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES;
  prevDays = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('HOME', prevHome);
  restore('NANOCLAW_CONVERSATIONS_DIR', prevConv);
  restore('CLAUDE_TRANSCRIPT_ROTATE_BYTES', prevBytes);
  restore('CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS', prevDays);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeProvider.maybeRotateContinuation', () => {
  it('keeps a small, recent transcript (returns null, leaves file in place)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    const p = writeTranscript('sess-small', 4096);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-small', CWD)).toBeNull();
    expect(fs.existsSync(p)).toBe(true);
  });

  it('rotates an oversized transcript (returns reason, moves the .jsonl aside)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    const p = writeTranscript('sess-big', 200 * 1024);
    const provider = new ClaudeProvider();
    const reason = provider.maybeRotateContinuation('sess-big', CWD);
    expect(reason).toContain('MB');
    expect(fs.existsSync(p)).toBe(false); // original moved out of the resume path
    const dir = path.dirname(p);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('sess-big.jsonl.rotated-'))).toBe(true);
  });

  it('rotates an aged transcript even when small', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = '7';
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    writeTranscript('sess-old', 2048, old);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-old', CWD)).toContain('d');
  });

  it('returns null for an unknown session id', () => {
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('does-not-exist', CWD)).toBeNull();
  });
});

describe('digestTranscriptMessages', () => {
  it('drops compact-continuation dumps and autocompact errors', () => {
    const digested = digestTranscriptMessages([
      { role: 'user', content: 'looks good, create the zip' },
      { role: 'assistant', content: 'Zip is done' },
      {
        role: 'user',
        content:
          'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
      },
      {
        role: 'assistant',
        content:
          'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.',
      },
    ]);
    expect(digested).toEqual([
      { role: 'user', content: 'looks good, create the zip' },
      { role: 'assistant', content: 'Zip is done' },
    ]);
  });

  it('keeps only the most recent real turns', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn ${i}`,
    }));
    const digested = digestTranscriptMessages(messages);
    expect(digested[0].content).toBe('turn 16');
    expect(digested.at(-1)?.content).toBe('turn 39');
    expect(digested).toHaveLength(24);
  });
});

describe('isCompactNoiseContent', () => {
  it('matches continuation dumps', () => {
    expect(isCompactNoiseContent('This session is being continued from a previous conversation')).toBe(true);
  });

  it('leaves real user text alone', () => {
    expect(isCompactNoiseContent('queue the psych email for Tuesday morning')).toBe(false);
  });
});
