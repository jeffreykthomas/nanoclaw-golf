import { describe, expect, it } from 'vitest';

import { extractBipbotTargetBranch } from './bipbot-branch.js';

describe('extractBipbotTargetBranch', () => {
  it('extracts bang-prefixed branch markers', () => {
    expect(
      extractBipbotTargetBranch(`
Issue: Example

!develop

Please fix the bug.
`),
    ).toBe('develop');
  });

  it('extracts the quoted branch from explicit branch instructions', () => {
    expect(
      extractBipbotTargetBranch(
        'This code lives on the `develop` branch — check out `develop`, not `main`.',
      ),
    ).toBe('develop');
    expect(
      extractBipbotTargetBranch(
        'On the `staging` branch, edit `src/components/Foo.vue`.',
      ),
    ).toBe('staging');
  });

  it('returns null when no authoritative branch instruction exists', () => {
    expect(
      extractBipbotTargetBranch(
        'Investigate why this issue keeps failing in CI and summarize the likely cause.',
      ),
    ).toBeNull();
  });
});
