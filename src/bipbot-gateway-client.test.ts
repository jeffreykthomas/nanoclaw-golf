import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BipbotGatewayClient } from './bipbot-gateway-client.js';

describe('BipbotGatewayClient', () => {
  let client: BipbotGatewayClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new BipbotGatewayClient({
      baseUrl: 'https://gateway.example.com/',
      token: 'test-token',
    });
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"status":"ok"}',
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('posts the gateway envelope with auth header', async () => {
    await client.enqueueLinearComment('ISSUE-1', 'Test comment');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example.com');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-token');

    const body = JSON.parse(opts.body);
    expect(body.action).toBe('enqueueLinearComment');
    expect(body.payload.issueId).toBe('ISSUE-1');
    expect(body.payload.body).toBe('Test comment');
  });

  it('treats duplicate status as success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => '{"status":"duplicate"}',
    });

    await expect(
      client.enqueueLinearComment('ISSUE-1', 'Test comment'),
    ).resolves.toBeUndefined();
  });

  it('uses the stable job id as the request id for codex jobs', async () => {
    await client.createCodexJob({
      jobId: 'job-BIP-123-abcdef1234567890',
      issueId: 'BIP-123',
      prompt: 'Implement the approved fix.',
    });

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.requestId).toBe('job-BIP-123-abcdef1234567890');
    expect(body.payload.jobId).toBe('job-BIP-123-abcdef1234567890');
  });

  it('retries on 5xx responses', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{"status":"ok"}',
      });

    vi.useFakeTimers();
    const promise = client.enqueueLinearComment('ISSUE-1', 'Retry me');
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on non-retryable errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    await expect(client.enqueueLinearComment('ISSUE-1', 'Bad')).rejects.toThrow(
      'BipBot gateway enqueueLinearComment failed: 400',
    );
  });
});
