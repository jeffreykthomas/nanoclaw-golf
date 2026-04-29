import {
  AUTO_CHECKINS_ENABLED,
  CHECKIN_ALLOWED_HOURS,
  CHECKIN_LOOP_INTERVAL_MS,
  CHECKIN_MIN_HOURS_SINCE_CHAT,
  CHECKIN_MIN_HOURS_SINCE_LAST_CHECKIN,
  TIMEZONE,
} from './config.js';
import {
  getAllUserProfileIndexes,
  markUserCheckInSent,
  storeCheckInMessage,
} from './db.js';
import { logger } from './logger.js';
import {
  getLatestCheckInContext,
  getLatestProfileSummary,
} from './profile/service.js';
import { isTelegramMirrorEnabled } from './telegram-notifier.js';
import type { UserProfileIndex } from './types.js';

export interface CheckInDecision {
  shouldSend: boolean;
  reason: string;
  urgency: 'gentle' | 'firm';
}

function hoursBetween(earlierIso: string, laterIso: string): number {
  const earlier = Date.parse(earlierIso);
  const later = Date.parse(laterIso);
  if (
    !Number.isFinite(earlier) ||
    !Number.isFinite(later) ||
    later <= earlier
  ) {
    return 0;
  }
  return (later - earlier) / (1000 * 60 * 60);
}

function currentHourInTimezone(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: TIMEZONE,
  }).format(now);
  return parseInt(hour, 10);
}

export function evaluateCheckInOpportunity(
  profile: UserProfileIndex,
  now = new Date(),
): CheckInDecision {
  if (!profile.last_interaction_at) {
    return {
      shouldSend: false,
      reason: 'no prior interaction',
      urgency: 'gentle',
    };
  }

  const nowIso = now.toISOString();
  const hour = currentHourInTimezone(now);
  if (!CHECKIN_ALLOWED_HOURS.includes(hour)) {
    return {
      shouldSend: false,
      reason: 'outside allowed hours',
      urgency: 'gentle',
    };
  }

  const hoursSinceChat = hoursBetween(profile.last_interaction_at, nowIso);
  if (hoursSinceChat < CHECKIN_MIN_HOURS_SINCE_CHAT) {
    return {
      shouldSend: false,
      reason: 'recent chat',
      urgency: 'gentle',
    };
  }

  if (profile.last_checkin_at) {
    const hoursSinceCheckIn = hoursBetween(profile.last_checkin_at, nowIso);
    if (hoursSinceCheckIn < CHECKIN_MIN_HOURS_SINCE_LAST_CHECKIN) {
      return {
        shouldSend: false,
        reason: 'recent check-in',
        urgency: 'gentle',
      };
    }
  }

  if (hoursSinceChat >= 48) {
    return {
      shouldSend: true,
      reason: `extended gap (${Math.floor(hoursSinceChat)}h since last chat)`,
      urgency: 'firm',
    };
  }

  return {
    shouldSend: true,
    reason: `good engagement window (${Math.floor(hoursSinceChat)}h since last chat)`,
    urgency: 'gentle',
  };
}

export function buildCheckInMessage(params: {
  summary?: string | null;
  recentContext?: string | null;
  urgency: 'gentle' | 'firm';
}): string {
  const summaryLine = params.summary
    ? params.summary.split('\n')[0]?.trim()
    : '';
  const opener =
    params.urgency === 'firm'
      ? 'Quick check-in from your golf coach and life coach: it has been a while since we last talked.'
      : 'Quick check-in from your golf coach and life coach.';

  const guidance = params.recentContext?.trim()
    ? `Recent context I have:\n${params.recentContext.trim()}`
    : summaryLine
      ? `Last profile note: ${summaryLine}`
      : 'Send me a quick update on golf, energy, priorities, or anything you want coaching on.';

  return `${opener}\n\n${guidance}\n\nIf helpful, reply with a quick note about your game, your day, or what feels most important right now.`;
}

export function startAutoCheckInLoop(
  sendMessage: (text: string) => Promise<boolean>,
): void {
  if (!AUTO_CHECKINS_ENABLED) {
    logger.info('Auto check-ins disabled');
    return;
  }
  if (!isTelegramMirrorEnabled()) {
    logger.info('Auto check-ins skipped: Telegram mirror not configured');
    return;
  }

  const loop = async () => {
    try {
      const profiles = getAllUserProfileIndexes();
      for (const profile of profiles) {
        const decision = evaluateCheckInOpportunity(profile);
        if (!decision.shouldSend) continue;

        const [summary, recentContext] = await Promise.all([
          getLatestProfileSummary(profile.user_id),
          getLatestCheckInContext(profile.user_id),
        ]);
        const message = buildCheckInMessage({
          summary,
          recentContext,
          urgency: decision.urgency,
        });
        storeCheckInMessage(profile.user_id, message);
        const sent = await sendMessage(message);
        markUserCheckInSent(profile.user_id);
        logger.info(
          {
            userId: profile.user_id,
            reason: decision.reason,
            telegramSent: sent,
          },
          'Automatic check-in sent',
        );
      }
    } catch (error) {
      logger.warn({ error }, 'Auto check-in loop failed');
    }

    setTimeout(loop, CHECKIN_LOOP_INTERVAL_MS).unref();
  };

  void loop();
}
