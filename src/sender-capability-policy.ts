import fs from 'fs';

import { SENDER_CAPABILITY_POLICY_PATH } from './config.js';
import { logger } from './logger.js';
import { SenderCapabilityProfile } from './types.js';

export interface ChatCapabilityPolicy {
  defaultProfile?: SenderCapabilityProfile;
  senders?: Record<string, SenderCapabilityProfile>;
}

export interface SenderCapabilityPolicyConfig {
  defaultProfile: SenderCapabilityProfile;
  chats: Record<string, ChatCapabilityPolicy>;
  logDenied: boolean;
}

const VALID_PROFILES: SenderCapabilityProfile[] = [
  'owner-full',
  'operator-safe',
  'gateway-system',
  'chat-only',
];

const DEFAULT_CONFIG: SenderCapabilityPolicyConfig = {
  defaultProfile: 'owner-full',
  chats: {},
  logDenied: true,
};

function isValidProfile(value: unknown): value is SenderCapabilityProfile {
  return (
    typeof value === 'string' &&
    VALID_PROFILES.includes(value as SenderCapabilityProfile)
  );
}

function sanitizeChatPolicy(value: unknown): ChatCapabilityPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const policy: ChatCapabilityPolicy = {};
  if (raw.defaultProfile !== undefined) {
    if (!isValidProfile(raw.defaultProfile)) return null;
    policy.defaultProfile = raw.defaultProfile;
  }

  if (raw.senders !== undefined) {
    if (!raw.senders || typeof raw.senders !== 'object') return null;
    const senders: Record<string, SenderCapabilityProfile> = {};
    for (const [sender, profile] of Object.entries(
      raw.senders as Record<string, unknown>,
    )) {
      if (!isValidProfile(profile)) return null;
      senders[sender] = profile;
    }
    policy.senders = senders;
  }

  return policy;
}

export function loadSenderCapabilityPolicy(
  pathOverride?: string,
): SenderCapabilityPolicyConfig {
  const filePath = pathOverride ?? SENDER_CAPABILITY_POLICY_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'sender-capability-policy: cannot read config',
    );
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-capability-policy: invalid JSON');
    return DEFAULT_CONFIG;
  }

  if (!parsed || typeof parsed !== 'object') {
    logger.warn(
      { path: filePath },
      'sender-capability-policy: invalid root object',
    );
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;
  if (!isValidProfile(obj.defaultProfile)) {
    logger.warn(
      { path: filePath },
      'sender-capability-policy: invalid or missing defaultProfile',
    );
    return DEFAULT_CONFIG;
  }

  const chats: Record<string, ChatCapabilityPolicy> = {};
  if (obj.chats !== undefined) {
    if (!obj.chats || typeof obj.chats !== 'object') {
      logger.warn(
        { path: filePath },
        'sender-capability-policy: invalid chats',
      );
      return DEFAULT_CONFIG;
    }
    for (const [chatJid, value] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      const policy = sanitizeChatPolicy(value);
      if (!policy) {
        logger.warn(
          { chatJid, path: filePath },
          'sender-capability-policy: skipping invalid chat policy',
        );
        continue;
      }
      chats[chatJid] = policy;
    }
  }

  return {
    defaultProfile: obj.defaultProfile,
    chats,
    logDenied: obj.logDenied !== false,
  };
}

export function resolveSenderCapability(
  chatJid: string,
  sender: string,
  cfg: SenderCapabilityPolicyConfig,
): SenderCapabilityProfile {
  if (sender === 'gateway-system') return 'gateway-system';

  const chatPolicy = cfg.chats[chatJid];
  const senderProfile = chatPolicy?.senders?.[sender];
  if (senderProfile) return senderProfile;

  if (chatPolicy?.defaultProfile) return chatPolicy.defaultProfile;
  return cfg.defaultProfile;
}

export function isCapabilityAllowed(
  requested: SenderCapabilityProfile,
  minimum: SenderCapabilityProfile,
): boolean {
  const rank: Record<SenderCapabilityProfile, number> = {
    'chat-only': 0,
    'operator-safe': 1,
    'gateway-system': 2,
    'owner-full': 3,
  };
  return rank[requested] >= rank[minimum];
}
