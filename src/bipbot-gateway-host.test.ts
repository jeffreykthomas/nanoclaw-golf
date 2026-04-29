import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gatewayMocks = vi.hoisted(() => ({
  createCodexJob: vi.fn(),
  enqueueLinearComment: vi.fn(),
  upsertProposal: vi.fn(),
  recordDecision: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('./config.js', () => ({
  BIPBOT_GATEWAY_URL: 'https://gateway.example.com',
  BIPBOT_GATEWAY_TOKEN: 'test-token',
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execFile: childProcessMocks.execFile,
}));

vi.mock('./bipbot-gateway-client.js', () => ({
  BipbotGatewayClient: class MockBipbotGatewayClient {
    createCodexJob = gatewayMocks.createCodexJob;
    enqueueLinearComment = gatewayMocks.enqueueLinearComment;
    upsertProposal = gatewayMocks.upsertProposal;
    recordDecision = gatewayMocks.recordDecision;
  },
}));

import { handleBipbotGatewayIpc } from './bipbot-gateway-host.js';

function expectedJobId(params: {
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
        params.prompt.replace(/\s+/g, ' ').trim(),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 16);

  return `job-${params.issueId}-${fingerprint}`;
}

describe('handleBipbotGatewayIpc', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-bipbot-'));
    vi.clearAllMocks();
    gatewayMocks.createCodexJob.mockResolvedValue(undefined);
    gatewayMocks.enqueueLinearComment.mockResolvedValue(undefined);
    gatewayMocks.upsertProposal.mockResolvedValue(undefined);
    gatewayMocks.recordDecision.mockResolvedValue(undefined);
    childProcessMocks.execFile.mockImplementation((_file, _args, callback) => {
      callback(null, '[]', '');
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('queues a Codex job and writes a success result file', async () => {
    const handled = await handleBipbotGatewayIpc(
      {
        type: 'bipbot_create_codex_job',
        requestId: 'req-1',
        issueId: 'BIP-123',
        version: 2,
        repoUrl: 'https://github.com/jeffreykthomas/bip-bot.git',
        branch: 'main',
        prompt: 'Implement the approved fix.',
        agent: 'codex',
      },
      'telegram_bipbot',
      false,
      tempDir,
    );

    expect(handled).toBe(true);
    expect(gatewayMocks.createCodexJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: expectedJobId({
          issueId: 'BIP-123',
          repoUrl: 'https://github.com/jeffreykthomas/bip-bot.git',
          branch: 'main',
          prompt: 'Implement the approved fix.',
          agent: 'codex',
        }),
        issueId: 'BIP-123',
        version: 2,
        repoUrl: 'https://github.com/jeffreykthomas/bip-bot.git',
        branch: 'main',
        prompt: 'Implement the approved fix.',
        agent: 'codex',
        status: 'approved',
      }),
    );

    const resultPath = path.join(
      tempDir,
      'ipc',
      'telegram_bipbot',
      'bipbot_results',
      'req-1.json',
    );
    expect(fs.existsSync(resultPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf-8'))).toMatchObject({
      success: true,
      message: 'Queued codex job for BIP-123 on branch main.',
    });
  });

  it('rejects invalid Codex job payloads without calling the gateway', async () => {
    const handled = await handleBipbotGatewayIpc(
      {
        type: 'bipbot_create_codex_job',
        requestId: 'req-2',
        issueId: 'BIP-124',
        branch: 'main',
        prompt: 'Missing fields',
        agent: 'codex',
      },
      'telegram_bipbot',
      false,
      tempDir,
    );

    expect(handled).toBe(true);
    expect(gatewayMocks.createCodexJob).not.toHaveBeenCalled();

    const resultPath = path.join(
      tempDir,
      'ipc',
      'telegram_bipbot',
      'bipbot_results',
      'req-2.json',
    );
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf-8'))).toMatchObject({
      success: false,
    });
  });

  it('reuses the same job id for equivalent prompts', async () => {
    await handleBipbotGatewayIpc(
      {
        type: 'bipbot_create_codex_job',
        requestId: 'req-3',
        issueId: 'BIP-125',
        version: 1,
        repoUrl: 'https://github.com/jeffreykthomas/bip-bot.git',
        branch: 'main',
        prompt: 'Implement the approved fix.',
        agent: 'codex',
      },
      'telegram_bipbot',
      false,
      tempDir,
    );

    await handleBipbotGatewayIpc(
      {
        type: 'bipbot_create_codex_job',
        requestId: 'req-4',
        issueId: 'BIP-125',
        version: 2,
        repoUrl: 'https://github.com/jeffreykthomas/bip-bot.git',
        branch: 'main',
        prompt: '  Implement   the approved fix.  ',
        agent: 'codex',
      },
      'telegram_bipbot',
      false,
      tempDir,
    );

    expect(gatewayMocks.createCodexJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        jobId: expectedJobId({
          issueId: 'BIP-125',
          repoUrl: 'https://github.com/jeffreykthomas/bip-bot.git',
          branch: 'main',
          prompt: 'Implement the approved fix.',
          agent: 'codex',
        }),
      }),
    );
    expect(gatewayMocks.createCodexJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        jobId: expectedJobId({
          issueId: 'BIP-125',
          repoUrl: 'https://github.com/jeffreykthomas/bip-bot.git',
          branch: 'main',
          prompt: 'Implement the approved fix.',
          agent: 'codex',
        }),
      }),
    );
  });

  it('skips queueing when an open pull request already exists', async () => {
    childProcessMocks.execFile.mockImplementation((_file, _args, callback) => {
      callback(
        null,
        JSON.stringify([
          {
            number: 351,
            title: 'Codex: Quiet stale welcome client ID errors',
            url: 'https://github.com/jeffreykthomas/bip-bot/pull/351',
          },
        ]),
        '',
      );
    });

    const handled = await handleBipbotGatewayIpc(
      {
        type: 'bipbot_create_codex_job',
        requestId: 'req-5',
        issueId: 'BIP-123',
        version: 3,
        repoUrl: 'https://github.com/jeffreykthomas/bip-bot.git',
        branch: 'main',
        prompt: 'Implement the approved fix.',
        agent: 'codex',
      },
      'telegram_bipbot',
      false,
      tempDir,
    );

    expect(handled).toBe(true);
    expect(gatewayMocks.createCodexJob).not.toHaveBeenCalled();

    const resultPath = path.join(
      tempDir,
      'ipc',
      'telegram_bipbot',
      'bipbot_results',
      'req-5.json',
    );
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf-8'))).toMatchObject({
      success: true,
      message:
        'Skipped codex job for BIP-123; open PR already exists: https://github.com/jeffreykthomas/bip-bot/pull/351',
    });
  });
});
