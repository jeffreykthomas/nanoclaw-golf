import { logger } from './logger.js';

export interface BipbotGatewayClientOpts {
  baseUrl: string;
  token: string;
}

type GatewayAction =
  | 'upsertProposal'
  | 'recordDecision'
  | 'createCodexJob'
  | 'enqueueLinearComment';

export class BipbotGatewayClient {
  private baseUrl: string;
  private token: string;

  constructor(opts: BipbotGatewayClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async post(
    action: GatewayAction,
    payload: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    const body = { action, requestId, payload };
    const delays = [1000, 2000, 4000];

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const response = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
        });

        if (response.ok) return;

        const responseBody = await response.text();
        try {
          const parsed = JSON.parse(responseBody) as { status?: string };
          if (parsed.status === 'duplicate') return;
        } catch {
          // Ignore parse failures and continue with status handling.
        }

        if (response.status >= 500 && attempt < delays.length) {
          logger.warn(
            { action, requestId, status: response.status, attempt },
            'BipBot gateway 5xx, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
          continue;
        }

        throw new Error(
          `BipBot gateway ${action} failed: ${response.status} ${responseBody}`,
        );
      } catch (err) {
        if (err instanceof TypeError && attempt < delays.length) {
          logger.warn(
            { action, requestId, err, attempt },
            'BipBot gateway network error, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
          continue;
        }
        throw err;
      }
    }
  }

  async enqueueLinearComment(issueId: string, body: string): Promise<void> {
    await this.post(
      'enqueueLinearComment',
      { issueId, body },
      `comment-${issueId}-${Date.now()}`,
    );
  }

  async createCodexJob(payload: Record<string, unknown>): Promise<void> {
    const issueId = String(payload.issueId || 'unknown');
    const requestId =
      typeof payload.jobId === 'string' && payload.jobId.trim()
        ? payload.jobId.trim()
        : `job-${issueId}-${Date.now()}`;
    await this.post('createCodexJob', payload, requestId);
  }

  async upsertProposal(payload: Record<string, unknown>): Promise<void> {
    const issueId = String(payload.issueId || 'unknown');
    await this.post(
      'upsertProposal',
      payload,
      `proposal-${issueId}-${Date.now()}`,
    );
  }

  async recordDecision(payload: Record<string, unknown>): Promise<void> {
    const issueId = String(payload.issueId || 'unknown');
    await this.post(
      'recordDecision',
      payload,
      `decision-${issueId}-${Date.now()}`,
    );
  }
}
