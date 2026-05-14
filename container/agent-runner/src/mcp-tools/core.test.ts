import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'url';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from '../current-batch.js';
import { sendFile, sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

function seedPeerDestination(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
}

function seedChannelDestination(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('ops', 'Ops', 'channel', 'telegram', 'tg:-456')`,
    )
    .run();
}

function seedSessionRouting(): void {
  getInboundDb().exec(`
    CREATE TABLE session_routing (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id  TEXT,
      thread_id    TEXT
    );
    INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
    VALUES (1, 'telegram', 'tg:-123', NULL);
  `);
}

function outboundCount(): number {
  return (getOutboundDb().prepare('SELECT COUNT(*) AS count FROM messages_out').get() as { count: number }).count;
}

describe('send_message tool', () => {
  test('stamps current batch in_reply_to on outbound rows', async () => {
    seedPeerDestination();
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  test('writes null when no batch is active', async () => {
    seedPeerDestination();
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  test('still supports the legacy single-destination fallback without active routing', async () => {
    seedChannelDestination();

    const result = await sendMessage.handler({ text: 'Proactive update.' });

    expect(result.isError).toBeUndefined();
    expect(outboundCount()).toBe(1);
  });
});

describe('send_file tool', () => {
  test('can send a file to the current conversation', async () => {
    seedSessionRouting();

    const result = await sendFile.handler({ path: fileURLToPath(import.meta.url), text: 'See attached.' });

    expect(result.isError).toBeUndefined();
    expect(outboundCount()).toBe(1);
  });
});
