import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildIntegrationMounts,
  parseIntegrationsFlag,
  resolveGroupIntegrations,
} from './google-integrations.js';
import { RegisteredGroup } from './types.js';

function group(integrations?: RegisteredGroup['containerConfig']) {
  return {
    name: 'Personal',
    folder: 'telegram_personal',
    trigger: '@Andy',
    added_at: '2026-10-13T00:00:00.000Z',
    containerConfig: integrations,
  } satisfies RegisteredGroup;
}

describe('resolveGroupIntegrations', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-integrations-'));
    fs.mkdirSync(path.join(home, '.gmail-mcp'));
    fs.writeFileSync(path.join(home, '.gmail-mcp', 'credentials.json'), '{}');
    fs.mkdirSync(path.join(home, '.calendar-mcp'));
    fs.writeFileSync(path.join(home, '.calendar-mcp', 'tokens.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('grants nothing when the group has not opted in', () => {
    expect(resolveGroupIntegrations(group(), 'owner-full', home)).toEqual({});
  });

  it('grants opted-in integrations to the owner', () => {
    const g = group({ integrations: { gmail: 'read', calendar: 'full' } });
    expect(resolveGroupIntegrations(g, 'owner-full', home)).toEqual({
      gmail: 'read',
      calendar: 'full',
    });
  });

  it('grants nothing to non-owner senders', () => {
    const g = group({ integrations: { gmail: 'full', calendar: 'full' } });
    for (const profile of [
      'operator-safe',
      'gateway-system',
      'chat-only',
    ] as const) {
      expect(resolveGroupIntegrations(g, profile, home)).toEqual({});
    }
  });

  it('skips integrations whose credentials are missing', () => {
    fs.rmSync(path.join(home, '.calendar-mcp', 'tokens.json'));
    const g = group({ integrations: { gmail: 'read', calendar: 'read' } });
    expect(resolveGroupIntegrations(g, 'owner-full', home)).toEqual({
      gmail: 'read',
    });
  });

  it('ignores invalid access values', () => {
    const g = group({
      integrations: { gmail: 'admin' as never, calendar: 'read' },
    });
    expect(resolveGroupIntegrations(g, 'owner-full', home)).toEqual({
      calendar: 'read',
    });
  });
});

describe('buildIntegrationMounts', () => {
  it('mounts only granted credential dirs, writable for token refresh', () => {
    expect(buildIntegrationMounts({ calendar: 'read' }, '/home/me')).toEqual([
      {
        hostPath: '/home/me/.calendar-mcp',
        containerPath: '/home/node/.calendar-mcp',
        readonly: false,
      },
    ]);
    expect(buildIntegrationMounts({}, '/home/me')).toEqual([]);
  });
});

describe('parseIntegrationsFlag', () => {
  it('parses names with optional access (default read)', () => {
    expect(parseIntegrationsFlag('gmail,calendar:full')).toEqual({
      gmail: 'read',
      calendar: 'full',
    });
  });

  it('returns empty config for an empty flag (disables all)', () => {
    expect(parseIntegrationsFlag('')).toEqual({});
  });

  it('rejects unknown integrations and access levels', () => {
    expect(() => parseIntegrationsFlag('slack')).toThrow(/Unknown/);
    expect(() => parseIntegrationsFlag('gmail:write')).toThrow(/Invalid/);
  });
});
