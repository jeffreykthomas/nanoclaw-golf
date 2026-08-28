import { describe, expect, it } from 'vitest';

import { MENTORS_CONTEXT_TRIM_ENV, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('MENTORS_CONTEXT_TRIM_ENV', () => {
  it('compacts at the default 165k window, not the old 80k Fable cap', () => {
    expect(MENTORS_CONTEXT_TRIM_ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('165000');
    expect(Number(MENTORS_CONTEXT_TRIM_ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW)).toBeGreaterThan(80000);
  });

  it('rotates transcripts before they become unloadable, but not every two days', () => {
    expect(Number(MENTORS_CONTEXT_TRIM_ENV.CLAUDE_TRANSCRIPT_ROTATE_BYTES)).toBe(8 * 1024 * 1024);
    expect(MENTORS_CONTEXT_TRIM_ENV.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS).toBe('7');
  });
});
