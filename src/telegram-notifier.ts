import { TELEGRAM_BOT_TOKEN, TELEGRAM_MIRROR_CHAT_ID } from './config.js';
import { sanitizeTelegramLegacyMarkdown } from './channels/telegram-markdown-sanitize.js';
import { log } from './log.js';

const TELEGRAM_PARSE_MODE = 'Markdown';

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

async function postMessage(chatId: string, text: string, parseMarkdown: boolean): Promise<Response> {
  const body: { chat_id: string; text: string; parse_mode?: string } = { chat_id: chatId, text };
  if (parseMarkdown) body.parse_mode = TELEGRAM_PARSE_MODE;

  return fetch(`${apiBase()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendChunk(chatId: string, text: string): Promise<void> {
  const sanitizedText = sanitizeTelegramLegacyMarkdown(text);
  const response = await postMessage(chatId, sanitizedText, true);
  if (response.ok) return;

  const body = await response.text().catch(() => '');
  log.warn('Telegram mirror Markdown send failed; retrying as plain text', { body });
  const fallbackResponse = await postMessage(chatId, sanitizedText, false);
  if (fallbackResponse.ok) return;

  const fallbackBody = await fallbackResponse.text().catch(() => '');
  throw new Error(`telegram_send_failed_${fallbackResponse.status}${fallbackBody ? `:${fallbackBody}` : ''}`);
}

export async function sendTelegramMirrorMessage(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || !isTelegramMirrorEnabled()) return false;
  const chatId = normalizeTelegramChatId(TELEGRAM_MIRROR_CHAT_ID);

  const maxLength = 4096;
  try {
    for (let i = 0; i < trimmed.length; i += maxLength) {
      await sendChunk(chatId, trimmed.slice(i, i + maxLength));
    }
    log.info('Telegram mirror message sent', { chatId, length: trimmed.length });
    return true;
  } catch (error) {
    log.warn('Telegram mirror send failed', { error });
    return false;
  }
}
