import { describe, expect, it } from 'vitest';

import {
  detectProfileCommand,
  getUserProfileInventoryView,
} from './service.js';

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

describe('getUserProfileInventoryView', () => {
  it('returns the full schema inventory even before a profile exists', async () => {
    const inventory = await getUserProfileInventoryView('missing-user');

    expect(inventory.schema_name).toBe('nanoclaw_user_coaching_profile');
    expect(inventory.profile_exists).toBe(false);
    expect(inventory.counts.total_fields).toBeGreaterThan(200);
    expect(inventory.counts.populated_fields).toBe(0);
    expect(inventory.categories[0].fields[0]).toMatchObject({
      key: 'core_roles',
      populated: false,
    });
  });
});
