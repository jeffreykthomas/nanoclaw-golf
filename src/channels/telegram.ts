import { Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  TELEGRAM_BOT_TOKENS,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onChannelOwner: (chatJid: string, channelOwner: string) => void;
  getChatRoute: (
    chatJid: string,
  ) => { channelOwner: string | null } | undefined;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface TelegramBotEntry {
  bot: Bot;
  token: string;
  ownerKey: string;
}

export function buildTelegramJid(
  chatId: number | string,
  ownerKey: string,
  isGroup: boolean,
): string {
  return isGroup ? `tg:${chatId}` : `tg:${ownerKey}:${chatId}`;
}

export function parseTelegramChatId(jid: string): string {
  const body = jid.replace(/^tg:/, '');
  const match = body.match(/(-?\d+)$/);
  return match ? match[1] : body;
}

function parseTelegramOwnerKey(jid: string): string | null {
  const body = jid.replace(/^tg:/, '');
  const match = body.match(/^(.*):(-?\d+)$/);
  return match ? match[1] : null;
}

function parseBotTokens(): string[] {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKENS']);
  const rawValues = [
    process.env.TELEGRAM_BOT_TOKEN,
    envVars.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_BOT_TOKENS,
    envVars.TELEGRAM_BOT_TOKENS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/[\n,]/))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(rawValues)];
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bots: TelegramBotEntry[] = [];
  private ownerByJid = new Map<string, string>();
  private opts: TelegramChannelOpts;
  private botTokens: string[];

  constructor(botTokens: string[] | string, opts: TelegramChannelOpts) {
    this.botTokens = Array.isArray(botTokens) ? botTokens : [botTokens];
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const connectPromises = this.botTokens.map((token, index) =>
      this.connectBot(token, index),
    );
    await Promise.all(connectPromises);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const botEntry = this.getBotForJid(jid);
    if (!botEntry) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = parseTelegramChatId(jid);

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await botEntry.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await botEntry.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info(
        { jid, length: text.length, owner: botEntry.ownerKey },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bots.length > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const entry of this.bots) {
      entry.bot.stop();
    }
    this.bots = [];
    logger.info('Telegram bots stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const botEntry = this.getBotForJid(jid);
    if (!botEntry) return;
    try {
      const numericId = parseTelegramChatId(jid);
      await botEntry.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  private async connectBot(token: string, index: number): Promise<void> {
    const bot = new Bot(token);
    const entry: TelegramBotEntry = {
      bot,
      token,
      ownerKey: `telegram:bot-${index + 1}`,
    };

    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const isGroup = chatType === 'group' || chatType === 'supergroup';
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';
      const registrationId = buildTelegramJid(chatId, entry.ownerKey, isGroup);

      ctx.reply(
        `Registration ID: \`${registrationId}\`\nRaw Chat ID: \`${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const chatJid = buildTelegramJid(ctx.chat.id, entry.ownerKey, isGroup);
      this.rememberOwner(chatJid, entry.ownerKey);
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName, owner: entry.ownerKey },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, owner: entry.ownerKey },
        'Telegram message stored',
      );
    });

    const storeNonText = (ctx: any, placeholder: string) => {
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const chatJid = buildTelegramJid(ctx.chat.id, entry.ownerKey, isGroup);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      this.rememberOwner(chatJid, entry.ownerKey);
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    bot.catch((err) => {
      logger.error(
        { err: err.message, owner: entry.ownerKey },
        'Telegram bot error',
      );
    });

    await new Promise<void>((resolve) => {
      bot.start({
        onStart: (botInfo) => {
          entry.ownerKey = `telegram:${botInfo.username}`;
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });

    this.bots.push(entry);
  }

  private rememberOwner(chatJid: string, ownerKey: string): void {
    this.ownerByJid.set(chatJid, ownerKey);
    this.opts.onChannelOwner(chatJid, ownerKey);
  }

  private getBotForJid(jid: string): TelegramBotEntry | undefined {
    const persistedOwner = this.opts.getChatRoute(jid)?.channelOwner;
    const ownerKey =
      persistedOwner || this.ownerByJid.get(jid) || parseTelegramOwnerKey(jid);
    if (ownerKey) {
      const match = this.bots.find((entry) => entry.ownerKey === ownerKey);
      if (match) return match;
    }
    if (this.bots.length === 1) return this.bots[0];
    if (this.bots.length > 1) {
      logger.warn(
        { jid, ownerKey },
        'Falling back to first Telegram bot for chat',
      );
    }
    return this.bots[0];
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const tokens = parseBotTokens();
  if (tokens.length === 0) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN(S) not set');
    return null;
  }
  if (tokens.length > 1) {
    logger.info(
      { botCount: tokens.length },
      'Telegram: multiple bot tokens configured',
    );
  } else if (TELEGRAM_BOT_TOKENS) {
    logger.info('Telegram: using multi-bot token configuration');
  }
  return new TelegramChannel(tokens, opts);
});
