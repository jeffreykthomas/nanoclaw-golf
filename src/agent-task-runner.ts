import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { getDueOutboundMessages } from './db/session-db.js';
import { resolveSession, openOutboundDb, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { applyCoachPortalMcpConfig, ensureCoachPortalGuidance, isCoachPortalFolder } from './coach-portal-mcp.js';
import { log } from './log.js';
import type { AgentGroup, MessageOut } from './types.js';

export interface AgentTaskOptions {
  folder: string;
  name: string;
  prompt: string;
  timeoutMs: number;
  channelType?: string;
  platformId?: string;
}

export interface AgentTaskResult {
  agentGroup: AgentGroup;
  sessionId: string;
  messageId: string;
  text: string;
  rawMessage: MessageOut;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeAgentGroupId(folder: string): string {
  return `agent-${folder.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

function ensureAgentGroup(folder: string, name: string): AgentGroup {
  const existing = getAgentGroupByFolder(folder);
  if (existing) return existing;

  const now = new Date().toISOString();
  const group: AgentGroup = {
    id: safeAgentGroupId(folder),
    name,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(group);
  return group;
}

function parseOutputText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;
  } catch {
    // Some providers/tools may write a raw text payload. Treat it as text.
  }
  return content;
}

async function waitForTaskOutput(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  timeoutMs: number,
): Promise<MessageOut> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let db;
    try {
      db = openOutboundDb(agentGroupId, sessionId);
      const rows = getDueOutboundMessages(db) as Array<MessageOut & { in_reply_to?: string | null }>;
      const reply = rows.find((row) => row.in_reply_to === messageId);
      if (reply) return reply;
    } catch {
      // The outbound DB may not exist until the session folder is initialized.
    } finally {
      db?.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`agent_task_timeout:${messageId}`);
}

export async function runAgentTask(options: AgentTaskOptions): Promise<AgentTaskResult> {
  const agentGroup = ensureAgentGroup(options.folder, options.name);
  if (isCoachPortalFolder(agentGroup.folder)) {
    applyCoachPortalMcpConfig(agentGroup.folder);
    ensureCoachPortalGuidance(agentGroup.folder, options.name);
  }
  const { session } = resolveSession(agentGroup.id, null, null, 'agent-shared');
  const messageId = makeId('task');
  const channelType = options.channelType ?? 'internal-task';
  const platformId = options.platformId ?? `task:${messageId}`;

  writeSessionMessage(agentGroup.id, session.id, {
    id: messageId,
    kind: 'task',
    timestamp: new Date().toISOString(),
    channelType,
    platformId,
    threadId: null,
    content: JSON.stringify({ prompt: options.prompt }),
    trigger: 1,
  });

  await wakeContainer(session);
  log.info('Agent task queued', {
    agentGroup: agentGroup.folder,
    sessionId: session.id,
    messageId,
  });

  const rawMessage = await waitForTaskOutput(agentGroup.id, session.id, messageId, options.timeoutMs);
  return {
    agentGroup,
    sessionId: session.id,
    messageId,
    text: parseOutputText(rawMessage.content),
    rawMessage,
  };
}
