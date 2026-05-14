import { Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { tryConsume } from './telegram-pairing.js';

interface TelegramBotEntry {
  bot: Bot;
  username: string;
}

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

interface TelegramRoute {
  chatId: string;
  botUsername?: string;
}

function parseBotTokens(): string[] {
  const env = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKENS']);
  const rawValues = [
    process.env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_BOT_TOKENS,
    env.TELEGRAM_BOT_TOKENS,
  ];
  return [
    ...new Set(
      rawValues
        .filter(Boolean)
        .flatMap((value) => String(value).split(/[\n,]/))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function platformIdFor(chatId: number | string, botUsername: string, isGroup: boolean): string {
  return isGroup ? `tg:${chatId}` : `tg:telegram:${botUsername}:${chatId}`;
}

export function parseTelegramRoute(platformId: string): TelegramRoute {
  const body = platformId.trim().replace(/^tg:/, '');
  const scoped = body.match(/^telegram:([^:]+):(.+)$/);
  if (scoped) {
    return { botUsername: scoped[1], chatId: scoped[2] };
  }
  const match = body.match(/(-?\d+)$/);
  return { chatId: match ? match[1] : body };
}

export function selectTelegramBotsForRoute<T extends Pick<TelegramBotEntry, 'username'>>(
  platformId: string,
  bots: T[],
): T[] {
  const route = parseTelegramRoute(platformId);
  if (!route.botUsername) return bots;
  const expected = route.botUsername.toLowerCase();
  return bots.filter((entry) => entry.username.toLowerCase() === expected);
}

function extractText(message: OutboundMessage): string | null {
  if (typeof message.content === 'string') return message.content;
  if (message.content && typeof message.content === 'object' && 'text' in message.content) {
    const text = (message.content as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

function isTelegramPhoto(filename: string): boolean {
  return TELEGRAM_PHOTO_EXTENSIONS.has(filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '');
}

async function sendTextChunks(entry: TelegramBotEntry, chatId: string, text: string): Promise<string | undefined> {
  let firstMessageId: string | undefined;
  for (let i = 0; i < text.length; i += TELEGRAM_TEXT_LIMIT) {
    const sent = await entry.bot.api.sendMessage(chatId, text.slice(i, i + TELEGRAM_TEXT_LIMIT));
    firstMessageId ??= String(sent.message_id);
  }
  return firstMessageId;
}

async function sendTelegramPayload(
  entry: TelegramBotEntry,
  chatId: string,
  text: string,
  files: OutboundMessage['files'],
): Promise<string | undefined> {
  let remainingText = text;
  let firstMessageId: string | undefined;

  for (const file of files ?? []) {
    const caption = remainingText.slice(0, TELEGRAM_CAPTION_LIMIT);
    remainingText = remainingText.slice(caption.length).trimStart();
    const options = caption ? { caption } : undefined;
    const inputFile = new InputFile(file.data, file.filename);
    const sent = isTelegramPhoto(file.filename)
      ? await entry.bot.api.sendPhoto(chatId, inputFile, options)
      : await entry.bot.api.sendDocument(chatId, inputFile, options);
    firstMessageId ??= String(sent.message_id);
  }

  if (remainingText) {
    firstMessageId ??= await sendTextChunks(entry, chatId, remainingText);
  }

  return firstMessageId;
}

function isMentioned(
  text: string,
  botUsername: string,
  botId: number,
  entities: Array<{ type: string; offset: number; length: number; user?: { id?: number } }> | undefined,
  isReplyToBot: boolean,
): boolean {
  if (isReplyToBot) return true;
  if (TRIGGER_PATTERN.test(text)) return true;
  if (text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;
  return (entities ?? []).some((entity) => {
    if (entity.type === 'text_mention') return entity.user?.id === botId;
    if (entity.type === 'mention') {
      return text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${botUsername.toLowerCase()}`;
    }
    return false;
  });
}

function createAdapter(tokens: string[]): ChannelAdapter {
  let setup: ChannelSetup | null = null;
  const bots: TelegramBotEntry[] = [];

  async function setupBot(token: string): Promise<void> {
    const bot = new Bot(token);
    const me = await bot.api.getMe();
    const username = me.username;
    if (!username) throw new Error('telegram_bot_username_missing');

    bot.command('chatid', async (ctx) => {
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const platformId = platformIdFor(ctx.chat.id, username, isGroup);
      await ctx.reply(`Registration ID: \`${platformId}\`\nRaw Chat ID: \`${ctx.chat.id}\``, {
        parse_mode: 'Markdown',
      });
    });

    bot.command('ping', async (ctx) => {
      await ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    bot.on('message:text', async (ctx) => {
      if (!setup || ctx.message.text.startsWith('/')) return;

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const platformId = platformIdFor(ctx.chat.id, username, isGroup);
      const senderId = ctx.from?.id ? `telegram:${ctx.from.id}` : undefined;
      const sender =
        ctx.from?.first_name || ctx.from?.username || (ctx.from?.id ? String(ctx.from.id) : undefined) || 'Unknown';
      const text = ctx.message.text;
      const chatName = ctx.chat.type === 'private' ? sender : 'title' in ctx.chat ? ctx.chat.title : platformId;
      const isMention =
        !isGroup ||
        isMentioned(text, username, me.id, ctx.message.entities, ctx.message.reply_to_message?.from?.id === me.id);

      const consumedPairing = await tryConsume({
        text,
        botUsername: username,
        platformId,
        isGroup,
        name: chatName,
        adminUserId: ctx.from?.id ? String(ctx.from.id) : null,
      });
      if (consumedPairing) return;

      log.info('Telegram inbound message received', {
        platformId,
        messageId: ctx.message.message_id,
        isGroup,
        isMention,
        entityTypes: ctx.message.entities?.map((entity) => entity.type) ?? [],
        isReplyToBot: ctx.message.reply_to_message?.from?.id === me.id,
      });
      setup.onMetadata(platformId, chatName, isGroup);

      const inbound: InboundMessage = {
        id: String(ctx.message.message_id),
        kind: 'chat',
        timestamp: new Date(ctx.message.date * 1000).toISOString(),
        isMention,
        isGroup,
        content: {
          text,
          sender,
          senderId,
        },
      };
      await setup.onInbound(platformId, null, inbound);
    });

    bots.push({ bot, username });
    void bot
      .start({
        drop_pending_updates: true,
        onStart(info) {
          log.info('Telegram bot connected', { username: info.username, id: info.id });
        },
      })
      .catch((err) => {
        log.error('Telegram bot polling stopped', { username, err });
      });
  }

  return {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setup = config;
      await Promise.all(tokens.map((token) => setupBot(token)));
    },

    async teardown(): Promise<void> {
      for (const entry of bots) entry.bot.stop();
      bots.length = 0;
      log.info('Telegram bots stopped');
    },

    isConnected(): boolean {
      return bots.length > 0;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const text = extractText(message) ?? '';
      const files = message.files ?? [];
      if (!text && files.length === 0) return undefined;

      const { chatId, botUsername } = parseTelegramRoute(platformId);
      if (bots.length === 0) throw new Error('telegram_bot_not_connected');

      const routeBots = selectTelegramBotsForRoute(platformId, bots);
      if (routeBots.length === 0) throw new Error(`telegram_bot_not_connected_for_${botUsername ?? 'route'}`);

      let lastError: unknown;
      for (const entry of routeBots) {
        let sentAny = false;
        try {
          const platformMsgId = await sendTelegramPayload(entry, chatId, text, files);
          sentAny = platformMsgId !== undefined;
          log.info('Telegram message sent', {
            platformId,
            length: text.length,
            fileCount: files.length,
            bot: entry.username,
          });
          return platformMsgId;
        } catch (err) {
          // If a multi-part send failed after something reached Telegram, do
          // not try another bot and risk duplicating partial delivery.
          if (sentAny) throw err;
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },

    async setTyping(platformId: string): Promise<void> {
      const { chatId } = parseTelegramRoute(platformId);
      const routeBots = selectTelegramBotsForRoute(platformId, bots);
      for (const entry of routeBots) {
        try {
          await entry.bot.api.sendChatAction(chatId, 'typing');
          return;
        } catch {
          // Try the next configured bot; only one may belong to this chat.
        }
      }
    },
  };
}

registerChannelAdapter('telegram', {
  factory() {
    const tokens = parseBotTokens();
    if (tokens.length === 0) return null;
    return createAdapter(tokens);
  },
});
