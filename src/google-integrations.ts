/**
 * Google integrations (Gmail, Calendar) for agent containers.
 *
 * Opt-in per group via `containerConfig.integrations`. Credentials live on
 * the host and are only mounted into containers for groups that enabled the
 * integration, and only when the sender is the owner.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';
import {
  GroupIntegrations,
  IntegrationAccess,
  RegisteredGroup,
  SenderCapabilityProfile,
} from './types.js';

export const GMAIL_CREDENTIALS_DIRNAME = '.gmail-mcp';
export const CALENDAR_CREDENTIALS_DIRNAME = '.calendar-mcp';

const INTEGRATION_CREDENTIAL_FILES: Record<keyof GroupIntegrations, string> = {
  gmail: 'credentials.json',
  calendar: 'tokens.json',
};

const INTEGRATION_DIRS: Record<keyof GroupIntegrations, string> = {
  gmail: GMAIL_CREDENTIALS_DIRNAME,
  calendar: CALENDAR_CREDENTIALS_DIRNAME,
};

export interface IntegrationMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function isAccess(value: unknown): value is IntegrationAccess {
  return value === 'read' || value === 'full';
}

/**
 * Integrations actually granted for this run: the group must opt in, the
 * sender must be the owner, and credentials must exist on the host.
 */
export function resolveGroupIntegrations(
  group: RegisteredGroup,
  capabilityProfile: SenderCapabilityProfile,
  homeDir: string = os.homedir(),
): GroupIntegrations {
  const requested = group.containerConfig?.integrations;
  if (!requested || capabilityProfile !== 'owner-full') return {};

  const granted: GroupIntegrations = {};
  for (const key of Object.keys(INTEGRATION_DIRS) as Array<
    keyof GroupIntegrations
  >) {
    const access = requested[key];
    if (!isAccess(access)) continue;
    const credentialFile = path.join(
      homeDir,
      INTEGRATION_DIRS[key],
      INTEGRATION_CREDENTIAL_FILES[key],
    );
    if (!fs.existsSync(credentialFile)) {
      logger.warn(
        { group: group.name, integration: key, credentialFile },
        'Integration enabled but credentials missing; skipping',
      );
      continue;
    }
    granted[key] = access;
  }
  return granted;
}

/**
 * Credential directories are writable so the MCP servers can refresh
 * OAuth access tokens.
 */
export function buildIntegrationMounts(
  integrations: GroupIntegrations,
  homeDir: string = os.homedir(),
): IntegrationMount[] {
  const mounts: IntegrationMount[] = [];
  for (const key of Object.keys(integrations) as Array<
    keyof GroupIntegrations
  >) {
    const dirname = INTEGRATION_DIRS[key];
    mounts.push({
      hostPath: path.join(homeDir, dirname),
      containerPath: `/home/node/${dirname}`,
      readonly: false,
    });
  }
  return mounts;
}

/** Parse `gmail:read,calendar:full` (setup CLI flag) into a config object. */
export function parseIntegrationsFlag(value: string): GroupIntegrations {
  const result: GroupIntegrations = {};
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, accessRaw = 'read'] = trimmed.split(':');
    if (name !== 'gmail' && name !== 'calendar') {
      throw new Error(`Unknown integration: ${name}`);
    }
    if (!isAccess(accessRaw)) {
      throw new Error(`Invalid access for ${name}: ${accessRaw}`);
    }
    result[name] = accessRaw;
  }
  return result;
}
