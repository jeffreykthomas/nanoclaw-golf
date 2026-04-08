import { describe, expect, it } from 'vitest';

import { normalizeTelegramChatId } from './telegram-notifier.js';

describe('normalizeTelegramChatId', () => {
  it('strips the NanoClaw tg prefix', () => {
    expect(normalizeTelegramChatId('tg:8498871121')).toBe('8498871121');
  });

  it('preserves a raw numeric chat id', () => {
    expect(normalizeTelegramChatId('8498871121')).toBe('8498871121');
  });

  it('trims whitespace', () => {
    expect(normalizeTelegramChatId('  tg:8498871121  ')).toBe('8498871121');
  });
});
