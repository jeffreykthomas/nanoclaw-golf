import { describe, expect, it, vi } from 'vitest';

import {
  collectTelegramMedia,
  extractTelegramAttachments,
  extractTelegramText,
  parseTelegramRoute,
  selectTelegramBotsForRoute,
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
});
