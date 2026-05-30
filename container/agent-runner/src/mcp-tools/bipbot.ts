import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'bipbot_results');
const RESULT_TIMEOUT_MS = 60_000;
const RESULT_POLL_MS = 1_000;

type GatewayResult = {
  success: boolean;
  message: string;
};

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arrayArg(args: Record<string, unknown>, key: string): unknown[] | null {
  const value = args[key];
  return Array.isArray(value) ? value : null;
}

function isBipbotAgent(): boolean {
  try {
    const config = JSON.parse(
      fs.readFileSync('/workspace/agent/container.json', 'utf-8'),
    ) as {
      agentGroupId?: string;
      groupName?: string;
      assistantName?: string;
    };
    return (
      config.agentGroupId === 'agent-bipbot' ||
      config.groupName === 'BipBot' ||
      config.assistantName === 'BipBot'
    );
  } catch {
    return false;
  }
}

function writeGatewayTask(payload: Record<string, unknown>): string {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const requestId = `${payload.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskPath = path.join(TASKS_DIR, `${requestId}.json`);
  const tmpPath = `${taskPath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({
      requestId,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  );
  fs.renameSync(tmpPath, taskPath);
  return requestId;
}

async function waitForGatewayResult(requestId: string): Promise<GatewayResult> {
  const resultPath = path.join(RESULTS_DIR, `${requestId}.json`);
  const deadline = Date.now() + RESULT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as GatewayResult;
        fs.rmSync(resultPath, { force: true });
        return result;
      } catch (readErr) {
        return {
          success: false,
          message: `Failed to read BipBot gateway result: ${
            readErr instanceof Error ? readErr.message : String(readErr)
          }`,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_MS));
  }

  return { success: false, message: 'BipBot gateway request timed out' };
}

async function callGateway(payload: Record<string, unknown>) {
  if (!isBipbotAgent()) {
    return err('BipBot gateway tools are only available to the BipBot agent.');
  }

  const requestId = writeGatewayTask(payload);
  const result = await waitForGatewayResult(requestId);
  return result.success ? ok(result.message) : err(result.message);
}

const createCodexJob: McpToolDefinition = {
  tool: {
    name: 'bipbot_create_codex_job',
    description:
      'Queue a code implementation job through the BipBot gateway. Use this instead of creating branches, pushes, or PRs directly.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Linear issue ID or gateway issue ID' },
        version: { type: 'number', description: 'Proposal or decision version' },
        repo_url: { type: 'string', description: 'Repository URL for the implementation job' },
        branch: { type: 'string', description: 'Base branch the implementation job should target' },
        prompt: { type: 'string', description: 'Implementation prompt for the downstream agent' },
        agent: {
          type: 'string',
          enum: ['codex', 'claude'],
          description: 'Which downstream coding agent should pick up the job',
        },
        claude_model: { type: 'string', description: 'Optional Claude model hint when agent=claude' },
      },
      required: ['issue_id', 'version', 'repo_url', 'branch', 'prompt', 'agent'],
    },
  },
  async handler(args) {
    const issueId = stringArg(args, 'issue_id');
    const version = numberArg(args, 'version');
    const repoUrl = stringArg(args, 'repo_url');
    const branch = stringArg(args, 'branch');
    const prompt = stringArg(args, 'prompt');
    const agent = stringArg(args, 'agent');
    if (!issueId || version === null || !repoUrl || !branch || !prompt || !agent) {
      return err('issue_id, version, repo_url, branch, prompt, and agent are required');
    }
    if (agent !== 'codex' && agent !== 'claude') {
      return err('agent must be "codex" or "claude"');
    }

    return callGateway({
      type: 'bipbot_create_codex_job',
      issueId,
      version,
      repoUrl,
      branch,
      prompt,
      agent,
      claudeModel: stringArg(args, 'claude_model') ?? undefined,
    });
  },
};

const enqueueLinearComment: McpToolDefinition = {
  tool: {
    name: 'bipbot_enqueue_linear_comment',
    description: 'Queue a Linear comment through the BipBot gateway for status updates, clarifications, or replies.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Linear issue ID' },
        body: { type: 'string', description: 'Comment body to enqueue' },
      },
      required: ['issue_id', 'body'],
    },
  },
  async handler(args) {
    const issueId = stringArg(args, 'issue_id');
    const body = stringArg(args, 'body');
    if (!issueId || !body) return err('issue_id and body are required');
    return callGateway({ type: 'bipbot_enqueue_linear_comment', issueId, body });
  },
};

const upsertProposal: McpToolDefinition = {
  tool: {
    name: 'bipbot_upsert_proposal',
    description: 'Store or update a proposal in the BipBot gateway without executing implementation directly.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Linear issue ID' },
        version: { type: 'number', description: 'Proposal version' },
        risk_assessment: { type: 'string', description: 'Overall risk assessment for the proposal' },
        options: {
          type: 'array',
          description: 'Proposal options',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              risk: { type: 'string' },
              implementation_prompt: { type: 'string' },
            },
            required: ['label', 'title', 'description', 'risk', 'implementation_prompt'],
          },
        },
        conversation_history: {
          type: 'array',
          description: 'Optional condensed conversation history',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
      },
      required: ['issue_id', 'version', 'risk_assessment', 'options'],
    },
  },
  async handler(args) {
    const issueId = stringArg(args, 'issue_id');
    const version = numberArg(args, 'version');
    const riskAssessment = stringArg(args, 'risk_assessment');
    const options = arrayArg(args, 'options');
    if (!issueId || version === null || !riskAssessment || !options) {
      return err('issue_id, version, risk_assessment, and options are required');
    }
    return callGateway({
      type: 'bipbot_upsert_proposal',
      issueId,
      version,
      riskAssessment,
      options,
      conversationHistory: arrayArg(args, 'conversation_history') ?? undefined,
    });
  },
};

const recordDecision: McpToolDefinition = {
  tool: {
    name: 'bipbot_record_decision',
    description: 'Record an approval or expiration decision in the BipBot gateway.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Linear issue ID' },
        version: { type: 'number', description: 'Proposal version' },
        choice: { type: 'string', description: 'Chosen option label, such as A/B/C' },
        rationale: { type: 'string', description: 'Why this decision was made' },
        status: {
          type: 'string',
          enum: ['approved', 'expired'],
          description: 'Decision status',
        },
      },
      required: ['issue_id', 'version', 'choice', 'rationale', 'status'],
    },
  },
  async handler(args) {
    const issueId = stringArg(args, 'issue_id');
    const version = numberArg(args, 'version');
    const choice = stringArg(args, 'choice');
    const rationale = stringArg(args, 'rationale');
    const status = stringArg(args, 'status');
    if (!issueId || version === null || !choice || !rationale || !status) {
      return err('issue_id, version, choice, rationale, and status are required');
    }
    if (status !== 'approved' && status !== 'expired') {
      return err('status must be "approved" or "expired"');
    }
    return callGateway({
      type: 'bipbot_record_decision',
      issueId,
      version,
      choice,
      rationale,
      status,
    });
  },
};

registerTools([
  createCodexJob,
  enqueueLinearComment,
  upsertProposal,
  recordDecision,
]);
