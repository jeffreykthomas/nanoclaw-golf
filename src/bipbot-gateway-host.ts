import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { BIPBOT_GATEWAY_TOKEN, BIPBOT_GATEWAY_URL } from './config.js';
import { BipbotGatewayClient } from './bipbot-gateway-client.js';
import { logger } from './logger.js';

interface GatewayResult {
  success: boolean;
  message: string;
}

interface ExistingPullRequest {
  number: number;
  title: string;
  url: string;
}

let gatewayClient: BipbotGatewayClient | null | undefined;

function getGatewayClient(): BipbotGatewayClient | null {
  if (gatewayClient !== undefined) return gatewayClient;
  if (!BIPBOT_GATEWAY_URL || !BIPBOT_GATEWAY_TOKEN) {
    gatewayClient = null;
    return gatewayClient;
  }
  gatewayClient = new BipbotGatewayClient({
    baseUrl: BIPBOT_GATEWAY_URL,
    token: BIPBOT_GATEWAY_TOKEN,
  });
  return gatewayClient;
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: GatewayResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'bipbot_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

function getRequiredString(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getOptionalString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getRequiredNumber(
  data: Record<string, unknown>,
  key: string,
): number | null {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fail(message: string): GatewayResult {
  return { success: false, message };
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim();
}

function buildCodexJobId(params: {
  issueId: string;
  repoUrl: string;
  branch: string;
  prompt: string;
  agent: 'codex' | 'claude';
}): string {
  const fingerprint = createHash('sha1')
    .update(
      [
        params.issueId.trim().toLowerCase(),
        params.repoUrl.trim(),
        params.branch.trim(),
        params.agent,
        normalizePrompt(params.prompt),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 16);

  return `job-${params.issueId}-${fingerprint}`;
}

function parseGitHubRepo(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();
  const httpsMatch = trimmed.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = trimmed.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  const sshUrlMatch = trimmed.match(
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (sshUrlMatch) {
    return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  return null;
}

async function findExistingOpenPullRequest(
  repoUrl: string,
  jobId: string,
): Promise<ExistingPullRequest | null> {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo) return null;

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'gh',
        [
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          'open',
          '--search',
          `"${jobId}"`,
          '--json',
          'number,title,url',
        ],
        (err, execStdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(execStdout);
        },
      );
    });

    const pullRequests = JSON.parse(stdout) as ExistingPullRequest[];
    return pullRequests[0] ?? null;
  } catch (err) {
    logger.warn(
      { err, jobId, repoUrl },
      'Failed to check for existing BipBot pull requests',
    );
    return null;
  }
}

export async function handleBipbotGatewayIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;
  if (!type?.startsWith('bipbot_')) return false;

  const requestId = getRequiredString(data, 'requestId');
  if (!requestId) {
    logger.warn({ type }, 'BipBot gateway IPC blocked: missing requestId');
    return true;
  }

  const client = getGatewayClient();
  if (!client) {
    writeResult(
      dataDir,
      sourceGroup,
      requestId,
      fail('BipBot gateway is not configured on the host.'),
    );
    return true;
  }

  let result: GatewayResult;
  try {
    switch (type) {
      case 'bipbot_create_codex_job': {
        const issueId = getRequiredString(data, 'issueId');
        const version = getRequiredNumber(data, 'version');
        const repoUrl = getRequiredString(data, 'repoUrl');
        const branch = getRequiredString(data, 'branch');
        const prompt = getRequiredString(data, 'prompt');
        const agent = getRequiredString(data, 'agent');
        if (!issueId || version === null || !repoUrl || !branch || !prompt) {
          result = fail(
            'Missing required fields for createCodexJob. Need issueId, version, repoUrl, branch, and prompt.',
          );
          break;
        }
        if (agent !== 'codex' && agent !== 'claude') {
          result = fail(
            'Invalid agent for createCodexJob. Use "codex" or "claude".',
          );
          break;
        }
        const claudeModel = getOptionalString(data, 'claudeModel');
        const jobId = buildCodexJobId({
          issueId,
          repoUrl,
          branch,
          prompt,
          agent,
        });
        const existingPullRequest = await findExistingOpenPullRequest(
          repoUrl,
          jobId,
        );
        if (existingPullRequest) {
          result = {
            success: true,
            message: `Skipped ${agent} job for ${issueId}; open PR already exists: ${existingPullRequest.url}`,
          };
          break;
        }
        await client.createCodexJob({
          jobId,
          issueId,
          version,
          repoUrl,
          branch,
          prompt,
          agent,
          status: 'approved',
          ...(claudeModel ? { claudeModel } : {}),
        });
        result = {
          success: true,
          message: `Queued ${agent} job for ${issueId} on branch ${branch}.`,
        };
        break;
      }

      case 'bipbot_enqueue_linear_comment': {
        const issueId = getRequiredString(data, 'issueId');
        const body = getRequiredString(data, 'body');
        if (!issueId || !body) {
          result = fail(
            'Missing required fields for enqueueLinearComment. Need issueId and body.',
          );
          break;
        }
        await client.enqueueLinearComment(issueId, body);
        result = {
          success: true,
          message: `Queued Linear comment for ${issueId}.`,
        };
        break;
      }

      case 'bipbot_upsert_proposal': {
        const issueId = getRequiredString(data, 'issueId');
        const version = getRequiredNumber(data, 'version');
        const riskAssessment = getRequiredString(data, 'riskAssessment');
        const options = data.options;
        const conversationHistory = data.conversationHistory;
        if (
          !issueId ||
          version === null ||
          !riskAssessment ||
          !Array.isArray(options)
        ) {
          result = fail(
            'Missing required fields for upsertProposal. Need issueId, version, options, and riskAssessment.',
          );
          break;
        }
        await client.upsertProposal({
          proposalId: `proposal-${issueId}-v${version}`,
          issueId,
          version,
          options,
          riskAssessment,
          ...(Array.isArray(conversationHistory)
            ? { conversationHistory }
            : {}),
        });
        result = {
          success: true,
          message: `Upserted proposal ${issueId} v${version}.`,
        };
        break;
      }

      case 'bipbot_record_decision': {
        const issueId = getRequiredString(data, 'issueId');
        const version = getRequiredNumber(data, 'version');
        const choice = getRequiredString(data, 'choice');
        const rationale = getRequiredString(data, 'rationale');
        const status = getRequiredString(data, 'status');
        if (!issueId || version === null || !choice || !rationale) {
          result = fail(
            'Missing required fields for recordDecision. Need issueId, version, choice, rationale, and status.',
          );
          break;
        }
        if (status !== 'approved' && status !== 'expired') {
          result = fail(
            'Invalid status for recordDecision. Use "approved" or "expired".',
          );
          break;
        }
        await client.recordDecision({
          decisionId: `decision-${issueId}-v${version}`,
          issueId,
          version,
          choice,
          rationale,
          status,
        });
        result = {
          success: true,
          message: `Recorded decision ${choice} for ${issueId} v${version}.`,
        };
        break;
      }

      default:
        return false;
    }
  } catch (err) {
    result = fail(
      err instanceof Error ? err.message : 'Unknown BipBot gateway error.',
    );
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info(
      { type, requestId, sourceGroup },
      'BipBot gateway request completed',
    );
  } else {
    logger.warn(
      { type, requestId, sourceGroup, message: result.message },
      'BipBot gateway request failed',
    );
  }
  return true;
}
