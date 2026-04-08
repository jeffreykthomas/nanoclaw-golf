import { SenderCapabilityProfile } from './types.js';

export function getSessionKey(
  groupFolder: string,
  capabilityProfile: SenderCapabilityProfile,
): string {
  return `${groupFolder}::${capabilityProfile}`;
}
