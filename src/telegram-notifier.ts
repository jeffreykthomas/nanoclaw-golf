import { TELEGRAM_BOT_TOKEN, TELEGRAM_MIRROR_CHAT_ID } from './config.js';
import { logger } from './logger.js';

function apiBase(): string {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
}

export function normalizeTelegramChatId(chatId: string): string {
  const trimmed = chatId.trim().replace(/^tg:/, '');
  const match = trimmed.match(/(-?\d+)$/);
  return match ? match[1] : trimmed;
}

export function isTelegramMirrorEnabled(): boolean {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_MIRROR_CHAT_ID);
}

async function sendChunk(chatId: string, text: string): Promise<void> {
  const response = await fetch(`${apiBase()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `telegram_send_failed_${response.status}${body ? `:${body}` : ''}`,
    );
  }
}

export async function sendTelegramMirrorMessage(
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || !isTelegramMirrorEnabled()) return false;
  const chatId = normalizeTelegramChatId(TELEGRAM_MIRROR_CHAT_ID);

  const maxLength = 4096;
  try {
    for (let i = 0; i < trimmed.length; i += maxLength) {
      await sendChunk(chatId, trimmed.slice(i, i + maxLength));
    }
    logger.info(
      { chatId, length: trimmed.length },
      'Telegram mirror message sent',
    );
    return true;
  } catch (error) {
    logger.warn({ error }, 'Telegram mirror send failed');
    return false;
  }
}
