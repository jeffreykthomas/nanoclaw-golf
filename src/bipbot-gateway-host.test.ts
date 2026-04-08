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

vi.mock('./bipbot-gateway-client.js', () => ({
  BipbotGatewayClient: class MockBipbotGatewayClient {
    createCodexJob = gatewayMocks.createCodexJob;
    enqueueLinearComment = gatewayMocks.enqueueLinearComment;
    upsertProposal = gatewayMocks.upsertProposal;
    recordDecision = gatewayMocks.recordDecision;
  },
}));

import { handleBipbotGatewayIpc } from './bipbot-gateway-host.js';

describe('handleBipbotGatewayIpc', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-bipbot-'));
    vi.clearAllMocks();
    gatewayMocks.createCodexJob.mockResolvedValue(undefined);
    gatewayMocks.enqueueLinearComment.mockResolvedValue(undefined);
    gatewayMocks.upsertProposal.mockResolvedValue(undefined);
    gatewayMocks.recordDecision.mockResolvedValue(undefined);
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
        jobId: 'job-BIP-123-v2',
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
});
