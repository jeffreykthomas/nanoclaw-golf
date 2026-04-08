import { describe, expect, it } from 'vitest';

import { detectProfileCommand } from './service.js';

describe('detectProfileCommand', () => {
  it('detects explicit profile report requests', () => {
    expect(detectProfileCommand('Generate my profile report')).toBe('report');
    expect(detectProfileCommand('Show me an inventory report')).toBe('report');
  });

  it('detects summary requests', () => {
    expect(detectProfileCommand('What do you know about me so far?')).toBe(
      'summary',
    );
  });
});
