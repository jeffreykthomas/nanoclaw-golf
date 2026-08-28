import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TELEGRAM_API_ROOT, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { tryConsume } from './telegram-pairing.js';

interface TelegramBotEntry {
  bot: Bot;
  username: string;
  token: string;
  apiRoot: string;
}

const DEFAULT_TELEGRAM_API_ROOT = 'https://api.telegram.org';
/** Cloud Bot API hard-codes 500s; a local server can stream multi-hundred-MB videos. */
const LOCAL_TELEGRAM_API_TIMEOUT_SECONDS = 3600;
const CONTAINER_BOT_API_DATA_DIR = '/var/lib/telegram-bot-api';

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const TELEGRAM_PARSE_MODE = 'Markdown' as const;

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  user?: { id?: number };
}

interface TelegramMediaFile {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  width?: number;
  height?: number;
  is_animated?: boolean;
  is_video?: boolean;
}

interface TelegramMessageLike {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  reply_to_message?: { from?: { id?: number } };
  photo?: TelegramMediaFile[];
  document?: TelegramMediaFile;
  video?: TelegramMediaFile;
  animation?: TelegramMediaFile;
  audio?: TelegramMediaFile;
  voice?: TelegramMediaFile;
  sticker?: TelegramMediaFile;
  video_note?: TelegramMediaFile;
}

interface TelegramInboundAttachment {
  type: string;
  name?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  data?: string;
  sourcePath?: string;
}

export type TelegramDownloadedFile = Buffer | { path: string };
export type TelegramFileDownloader = (fileId: string) => Promise<TelegramDownloadedFile>;

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

export function resolveTelegramApiRoot(raw = TELEGRAM_API_ROOT): string {
  const value = raw.trim().replace(/\/$/, '');
  return value || DEFAULT_TELEGRAM_API_ROOT;
}

export function isTelegramCloudApi(apiRoot: string): boolean {
  return resolveTelegramApiRoot(apiRoot) === DEFAULT_TELEGRAM_API_ROOT;
}

/**
 * Cloud Bot API `getFile` is capped at 20MB. A local Bot API server returns
 * either a relative path (download via `${apiRoot}/file/bot<token>/...`) or,
 * with `--local`, an absolute filesystem path the server already fetched.
 */
export function telegramFileDownloadTarget(
  apiRoot: string,
  token: string,
  filePath: string,
): { kind: 'local'; path: string } | { kind: 'url'; url: string } {
  if (filePath.startsWith('/')) return { kind: 'local', path: remapTelegramBotApiPath(filePath) };
  return { kind: 'url', url: `${resolveTelegramApiRoot(apiRoot)}/file/bot${token}/${filePath}` };
}

/**
 * `--local` Bot API returns container paths under `/var/lib/telegram-bot-api`.
 * NanoClaw runs on the host, so map that onto the bind-mounted data dir.
 */
export function remapTelegramBotApiPath(
  filePath: string,
  hostDataDir = process.env.TELEGRAM_BOT_API_DATA || path.join(process.cwd(), 'data/telegram-bot-api'),
): string {
  if (filePath === CONTAINER_BOT_API_DATA_DIR || filePath.startsWith(`${CONTAINER_BOT_API_DATA_DIR}/`)) {
    return path.join(hostDataDir, filePath.slice(CONTAINER_BOT_API_DATA_DIR.length));
  }
  return filePath;
}

function telegramClientOptions(apiRoot: string) {
  const root = resolveTelegramApiRoot(apiRoot);
  return {
    apiRoot: root,
    timeoutSeconds: isTelegramCloudApi(root) ? 500 : LOCAL_TELEGRAM_API_TIMEOUT_SECONDS,
  };
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

export function extractTelegramText(message: TelegramMessageLike): string {
  return message.text ?? message.caption ?? '';
}

function attachmentMetadata(
  type: string,
  file: TelegramMediaFile,
  name?: string,
  mimeType?: string,
): TelegramInboundAttachment {
  const attachment: TelegramInboundAttachment = { type };
  if (name) attachment.name = name;
  if (mimeType) attachment.mimeType = mimeType;
  if (typeof file.file_size === 'number') attachment.size = file.file_size;
  if (typeof file.width === 'number') attachment.width = file.width;
  if (typeof file.height === 'number') attachment.height = file.height;
  return attachment;
}

function largestPhoto(photos: TelegramMediaFile[]): TelegramMediaFile | undefined {
  return photos.reduce<TelegramMediaFile | undefined>((best, photo) => {
    if (!best) return photo;
    const bestScore = best.file_size ?? (best.width ?? 0) * (best.height ?? 0);
    const score = photo.file_size ?? (photo.width ?? 0) * (photo.height ?? 0);
    return score > bestScore ? photo : best;
  }, undefined);
}

export function collectTelegramMedia(
  message: TelegramMessageLike,
): Array<{ type: string; file: TelegramMediaFile; meta: TelegramInboundAttachment }> {
  const media: Array<{ type: string; file: TelegramMediaFile; meta: TelegramInboundAttachment }> = [];

  const photo = message.photo ? largestPhoto(message.photo) : undefined;
  if (photo)
    media.push({ type: 'photo', file: photo, meta: attachmentMetadata('photo', photo, undefined, 'image/jpeg') });
  if (message.document) {
    media.push({
      type: 'document',
      file: message.document,
      meta: attachmentMetadata('document', message.document, message.document.file_name, message.document.mime_type),
    });
  }
  if (message.video) {
    media.push({
      type: 'video',
      file: message.video,
      meta: attachmentMetadata('video', message.video, message.video.file_name, message.video.mime_type ?? 'video/mp4'),
    });
  }
  if (message.animation) {
    media.push({
      type: 'animation',
      file: message.animation,
      meta: attachmentMetadata(
        'animation',
        message.animation,
        message.animation.file_name,
        message.animation.mime_type ?? 'video/mp4',
      ),
    });
  }
  if (message.audio) {
    media.push({
      type: 'audio',
      file: message.audio,
      meta: attachmentMetadata('audio', message.audio, message.audio.file_name, message.audio.mime_type),
    });
  }
  if (message.voice) {
    media.push({
      type: 'voice',
      file: message.voice,
      meta: attachmentMetadata('voice', message.voice, undefined, message.voice.mime_type ?? 'audio/ogg'),
    });
  }
  if (message.sticker) {
    const mimeType = message.sticker.is_video
      ? 'video/webm'
      : message.sticker.is_animated
        ? 'application/x-tgsticker'
        : 'image/webp';
    media.push({
      type: 'sticker',
      file: message.sticker,
      meta: attachmentMetadata('sticker', message.sticker, undefined, mimeType),
    });
  }
  if (message.video_note) {
    media.push({
      type: 'video',
      file: message.video_note,
      meta: attachmentMetadata('video', message.video_note, undefined, 'video/mp4'),
    });
  }

  return media;
}

export async function extractTelegramAttachments(
  message: TelegramMessageLike,
  downloadFile: TelegramFileDownloader,
): Promise<TelegramInboundAttachment[]> {
  const attachments: TelegramInboundAttachment[] = [];
  for (const item of collectTelegramMedia(message)) {
    const attachment = { ...item.meta };
    // Keep the message routable even if Telegram media download fails.
    /* eslint-disable no-catch-all/no-catch-all */
    try {
      const downloaded = await downloadFile(item.file.file_id);
      if (Buffer.isBuffer(downloaded)) {
        attachment.data = downloaded.toString('base64');
      } else {
        attachment.sourcePath = downloaded.path;
      }
    } catch (err) {
      log.warn('Failed to download Telegram attachment', { type: item.type, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
    attachments.push(attachment);
  }
  return attachments;
}

async function downloadTelegramFile(entry: TelegramBotEntry, fileId: string): Promise<TelegramDownloadedFile> {
  const file = await entry.bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('telegram_file_path_missing');

  const target = telegramFileDownloadTarget(entry.apiRoot, entry.token, file.file_path);
  if (target.kind === 'local') {
    await fs.promises.access(target.path);
    return { path: target.path };
  }

  const response = await fetch(target.url);
  if (!response.ok) throw new Error(`telegram_file_download_failed_${response.status}`);
  const tmpPath = path.join(os.tmpdir(), `nanoclaw-tg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (!response.body) {
    await fs.promises.writeFile(tmpPath, Buffer.from(await response.arrayBuffer()));
    return { path: tmpPath };
  }
  await pipeline(Readable.fromWeb(response.body as import('stream/web').ReadableStream), fs.createWriteStream(tmpPath));
  return { path: tmpPath };
}

async function sendTextChunks(entry: TelegramBotEntry, chatId: string, text: string): Promise<string | undefined> {
  const sanitizedText = sanitizeTelegramLegacyMarkdown(text);
  let firstMessageId: string | undefined;
  for (let i = 0; i < sanitizedText.length; i += TELEGRAM_TEXT_LIMIT) {
    const chunk = sanitizedText.slice(i, i + TELEGRAM_TEXT_LIMIT);
    let sent;
    try {
      sent = await entry.bot.api.sendMessage(chatId, chunk, { parse_mode: TELEGRAM_PARSE_MODE });
    } catch (err) {
      log.warn('Telegram Markdown send failed; retrying as plain text', { err });
      sent = await entry.bot.api.sendMessage(chatId, chunk);
    }
    firstMessageId ??= String(sent.message_id);
  }
  return firstMessageId;
}

export async function sendTelegramPayload(
  entry: TelegramBotEntry,
  chatId: string,
  text: string,
  files: OutboundMessage['files'],
): Promise<string | undefined> {
  let remainingText = sanitizeTelegramLegacyMarkdown(text);
  let firstMessageId: string | undefined;

  for (const file of files ?? []) {
    const caption = remainingText.slice(0, TELEGRAM_CAPTION_LIMIT);
    remainingText = remainingText.slice(caption.length).trimStart();
    const inputFile = new InputFile(file.data, file.filename);
    let sent;
    try {
      const options = caption ? { caption, parse_mode: TELEGRAM_PARSE_MODE } : undefined;
      sent = isTelegramPhoto(file.filename)
        ? await entry.bot.api.sendPhoto(chatId, inputFile, options)
        : await entry.bot.api.sendDocument(chatId, inputFile, options);
    } catch (err) {
      if (!caption) throw err;
      log.warn('Telegram Markdown caption failed; retrying as plain text', { err });
      const options = { caption };
      sent = isTelegramPhoto(file.filename)
        ? await entry.bot.api.sendPhoto(chatId, inputFile, options)
        : await entry.bot.api.sendDocument(chatId, inputFile, options);
    }
    firstMessageId ??= String(sent.message_id);
  }

  if (remainingText) {
    // Always send leftover body. `??=` would skip this once the file send
    // already set firstMessageId — which is how captions over 1024 chars
    // were delivered truncated with no follow-up message.
    const overflowId = await sendTextChunks(entry, chatId, remainingText);
    firstMessageId ??= overflowId;
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
    const apiRoot = resolveTelegramApiRoot();
    const bot = new Bot(token, { client: telegramClientOptions(apiRoot) });
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

    bot.on('message', async (ctx) => {
      if (!setup) return;

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const platformId = platformIdFor(ctx.chat.id, username, isGroup);
      const senderId = ctx.from?.id ? `telegram:${ctx.from.id}` : undefined;
      const sender =
        ctx.from?.first_name || ctx.from?.username || (ctx.from?.id ? String(ctx.from.id) : undefined) || 'Unknown';
      const message = ctx.message as TelegramMessageLike;
      const text = extractTelegramText(message);
      if (text.startsWith('/')) return;
      const attachments = await extractTelegramAttachments(message, (fileId) =>
        downloadTelegramFile({ bot, username, token, apiRoot }, fileId),
      );
      if (!text && attachments.length === 0) return;

      const chatName = ctx.chat.type === 'private' ? sender : 'title' in ctx.chat ? ctx.chat.title : platformId;
      const isMention =
        !isGroup ||
        isMentioned(
          text,
          username,
          me.id,
          message.entities ?? message.caption_entities,
          message.reply_to_message?.from?.id === me.id,
        );

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
        messageId: message.message_id,
        isGroup,
        isMention,
        entityTypes: (message.entities ?? message.caption_entities)?.map((entity) => entity.type) ?? [],
        isReplyToBot: message.reply_to_message?.from?.id === me.id,
        attachmentCount: attachments.length,
      });
      setup.onMetadata(platformId, chatName, isGroup);

      const inbound: InboundMessage = {
        id: String(message.message_id),
        kind: 'chat',
        timestamp: new Date(message.date * 1000).toISOString(),
        isMention,
        isGroup,
        content: {
          text,
          sender,
          senderId,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      };
      await setup.onInbound(platformId, null, inbound);
    });

    bots.push({ bot, username, token, apiRoot });
    void bot
      .start({
        drop_pending_updates: true,
        onStart(info) {
          log.info('Telegram bot connected', {
            username: info.username,
            id: info.id,
            apiRoot,
          });
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
