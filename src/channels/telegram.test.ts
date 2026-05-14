import { describe, expect, it } from 'vitest';

import { parseTelegramRoute, selectTelegramBotsForRoute } from './telegram.js';

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
