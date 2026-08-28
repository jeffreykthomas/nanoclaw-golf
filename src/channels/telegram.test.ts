import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  collectTelegramMedia,
  extractTelegramAttachments,
  extractTelegramText,
  isTelegramCloudApi,
  parseTelegramRoute,
  remapTelegramBotApiPath,
  resolveTelegramApiRoot,
  selectTelegramBotsForRoute,
  sendTelegramPayload,
  telegramFileDownloadTarget,
} from './telegram.js';
import { log } from '../log.js';

describe('telegram routing', () => {
  it('keeps bot-scoped private DMs on the encoded bot', () => {
    const route = parseTelegramRoute('tg:telegram:andy_bip_bot:8498871121');

    expect(route).toEqual({ botUsername: 'andy_bip_bot', chatId: '8498871121' });
    expect(
      selectTelegramBotsForRoute('tg:telegram:andy_bip_bot:8498871121', [
        { username: 'personal_bot' },
        { username: 'andy_bip_bot' },
      ]),
    ).toEqual([{ username: 'andy_bip_bot' }]);
  });

  it('preserves legacy unscoped Telegram routes', () => {
    expect(parseTelegramRoute('tg:-5135159854')).toEqual({ chatId: '-5135159854' });
    expect(selectTelegramBotsForRoute('tg:-5135159854', [{ username: 'personal_bot' }])).toEqual([
      { username: 'personal_bot' },
    ]);
  });
});

describe('telegram inbound media', () => {
  it('uses captions as inbound text when media carries the user message', () => {
    expect(extractTelegramText({ message_id: 1, date: 1, caption: 'This logo' })).toBe('This logo');
  });

  it('selects the largest Telegram photo variant and downloads it', async () => {
    const attachments = await extractTelegramAttachments(
      {
        message_id: 2,
        date: 1,
        photo: [
          { file_id: 'small', file_size: 100, width: 90, height: 90 },
          { file_id: 'large', file_size: 400, width: 360, height: 360 },
        ],
      },
      async (fileId) => Buffer.from(`downloaded:${fileId}`),
    );

    expect(attachments).toEqual([
      {
        type: 'photo',
        mimeType: 'image/jpeg',
        size: 400,
        width: 360,
        height: 360,
        data: Buffer.from('downloaded:large').toString('base64'),
      },
    ]);
  });

  it('keeps document filenames and MIME types for inbox staging', () => {
    expect(
      collectTelegramMedia({
        message_id: 3,
        date: 1,
        document: {
          file_id: 'doc-1',
          file_name: 'flyer.pdf',
          mime_type: 'application/pdf',
          file_size: 1234,
        },
      }).map((item) => item.meta),
    ).toEqual([
      {
        type: 'document',
        name: 'flyer.pdf',
        mimeType: 'application/pdf',
        size: 1234,
      },
    ]);
  });

  it('still reports attachment metadata if Telegram download fails', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    const attachments = await extractTelegramAttachments(
      {
        message_id: 4,
        date: 1,
        video: {
          file_id: 'video-1',
          file_name: 'clip.mp4',
          mime_type: 'video/mp4',
          width: 1920,
          height: 1080,
        },
      },
      async () => {
        throw new Error('network unavailable');
      },
    );
    warnSpy.mockRestore();

    expect(attachments).toEqual([
      {
        type: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        width: 1920,
        height: 1080,
      },
    ]);
  });

  it('keeps a sourcePath when the downloader returns a local file', async () => {
    const attachments = await extractTelegramAttachments(
      {
        message_id: 5,
        date: 1,
        video: { file_id: 'video-2', file_name: 'clip.mp4', mime_type: 'video/mp4' },
      },
      async () => ({ path: '/tmp/clip.mp4' }),
    );

    expect(attachments).toEqual([
      {
        type: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        sourcePath: '/tmp/clip.mp4',
      },
    ]);
  });
});

describe('telegram Bot API root', () => {
  it('strips trailing slashes and defaults to the cloud API', () => {
    expect(resolveTelegramApiRoot('https://api.telegram.org/')).toBe('https://api.telegram.org');
    expect(resolveTelegramApiRoot('')).toBe('https://api.telegram.org');
    expect(isTelegramCloudApi('https://api.telegram.org/')).toBe(true);
    expect(isTelegramCloudApi('http://127.0.0.1:8081')).toBe(false);
  });

  it('downloads cloud and non-local files over HTTP', () => {
    expect(telegramFileDownloadTarget('https://api.telegram.org', 'TOKEN', 'videos/clip.mp4')).toEqual({
      kind: 'url',
      url: 'https://api.telegram.org/file/botTOKEN/videos/clip.mp4',
    });
    expect(telegramFileDownloadTarget('http://127.0.0.1:8081/', 'TOKEN', 'videos/clip.mp4')).toEqual({
      kind: 'url',
      url: 'http://127.0.0.1:8081/file/botTOKEN/videos/clip.mp4',
    });
  });

  it('reads absolute paths from a local Bot API server', () => {
    expect(
      telegramFileDownloadTarget('http://127.0.0.1:8081', 'TOKEN', '/var/lib/telegram-bot-api/videos/clip.mp4'),
    ).toEqual({
      kind: 'local',
      path: path.join(process.cwd(), 'data/telegram-bot-api/videos/clip.mp4'),
    });
  });

  it('leaves non-container absolute paths unchanged', () => {
    expect(remapTelegramBotApiPath('/tmp/clip.mp4')).toBe('/tmp/clip.mp4');
  });
});

describe('telegram file caption overflow', () => {
  it('sends leftover body after a document caption instead of dropping it', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 2 });
    const sendDocument = vi.fn().mockResolvedValue({ message_id: 1 });
    const text = `${'A'.repeat(1024)} leftover-tail`;

    const platformMsgId = await sendTelegramPayload(
      {
        bot: { api: { sendMessage, sendDocument } },
        username: 'mentors_more_bot',
        token: 'TOKEN',
        apiRoot: 'https://api.telegram.org',
      } as never,
      '-5135159854',
      text,
      [{ filename: 'dels-game-plan.pdf', data: Buffer.from('%PDF') }],
    );

    expect(platformMsgId).toBe('1');
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendDocument.mock.calls[0][2]).toEqual(
      expect.objectContaining({ caption: 'A'.repeat(1024), parse_mode: 'Markdown' }),
    );
    expect(sendMessage.mock.calls[0][1]).toBe('leftover-tail');
  });
});
