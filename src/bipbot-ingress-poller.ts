import fs from 'fs';

import type { ServiceAccount } from 'firebase-admin/app';

import { extractBipbotTargetBranch } from './bipbot-branch.js';
import { BIPBOT_INGRESS_POLL_INTERVAL } from './config.js';
import { log } from './log.js';

export interface BipbotGithubTarget {
  prUrl: string | null;
  updatePr: boolean;
}

export interface BipbotIngressEvent {
  docId: string;
  jobId: string;
  issueId: string;
  issueUrl: string;
  sourceCommentId: string | null;
  sourceUrl: string | null;
  repoUrl: string | null;
  branch: string | null;
  prompt: string;
  sourceType: string;
  github?: BipbotGithubTarget;
  actor?: Record<string, unknown>;
}

export interface BipbotIngressPollerDeps {
  onIngressEvent: (event: BipbotIngressEvent) => Promise<void>;
}

let pollerRunning = false;

function getString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getGithubTarget(data: Record<string, unknown>): BipbotGithubTarget | undefined {
  const value = data.github;
  if (!value || typeof value !== 'object') return undefined;
  const github = value as Record<string, unknown>;
  const prUrl = getString(github, 'prUrl');
  const updatePr = github.updatePr === true;
  return prUrl || updatePr ? { prUrl, updatePr } : undefined;
}

export async function startBipbotIngressPoller(
  serviceAccountPath: string,
  deps: BipbotIngressPollerDeps,
): Promise<void> {
  if (pollerRunning) {
    log.debug('BipBot ingress poller already running');
    return;
  }
  pollerRunning = true;

  let appModule: typeof import('firebase-admin/app');
  let firestoreModule: typeof import('firebase-admin/firestore');
  try {
    appModule = await import('firebase-admin/app');
    firestoreModule = await import('firebase-admin/firestore');
  } catch (err) {
    log.error('firebase-admin not installed. Run: corepack pnpm add firebase-admin', { err });
    pollerRunning = false;
    return;
  }

  let serviceAccount: Record<string, unknown>;
  try {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));
  } catch (err) {
    log.error('Failed to read BipBot Firebase service account', { err, path: serviceAccountPath });
    pollerRunning = false;
    return;
  }

  const appName = 'bipbot-ingress';
  const app =
    appModule.getApps().find((existing) => existing.name === appName) ||
    appModule.initializeApp({ credential: appModule.cert(serviceAccount as ServiceAccount) }, appName);
  const db = firestoreModule.getFirestore(app);
  const collection = db.collection('nanoClawIngress');

  const poll = async () => {
    try {
      const snapshot = await collection.where('status', '==', 'queued').limit(10).get();
      if (snapshot.empty) {
        setTimeout(poll, BIPBOT_INGRESS_POLL_INTERVAL);
        return;
      }

      for (const doc of snapshot.docs.slice(0, 1)) {
        try {
          const claimed = await db.runTransaction(async (txn: FirebaseFirestore.Transaction) => {
            const fresh = await txn.get(doc.ref);
            if (!fresh.exists || fresh.data()?.status !== 'queued') {
              return false;
            }
            txn.update(doc.ref, {
              status: 'processing',
              claimedAt: new Date().toISOString(),
              claimedBy: 'nanoclaw-golf',
            });
            return true;
          });
          if (!claimed) continue;

          const data = doc.data();
          const prompt = String(data.prompt || '');
          const explicitBranch = getString(data, 'branch') || getString(data, 'baseBranch');
          const issueUrl = getString(data, 'issueUrl') ?? '';
          const sourceUrl = getString(data, 'sourceUrl') || issueUrl || null;
          const event: BipbotIngressEvent = {
            docId: doc.id,
            jobId: String(data.jobId || doc.id),
            issueId: String(data.issueId || doc.id),
            issueUrl,
            sourceCommentId: getString(data, 'sourceCommentId'),
            sourceUrl,
            repoUrl: getString(data, 'repoUrl') || getString(data, 'repositoryUrl'),
            branch: explicitBranch || extractBipbotTargetBranch(prompt),
            prompt,
            sourceType: String(data.sourceType || 'bipbot'),
            github: getGithubTarget(data),
            actor: data.actor && typeof data.actor === 'object' ? (data.actor as Record<string, unknown>) : undefined,
          };

          await deps.onIngressEvent(event);
          await doc.ref.update({
            status: 'processed',
            processedAt: new Date().toISOString(),
          });
        } catch (err) {
          log.error('Failed to process BipBot ingress doc', { docId: doc.id, err });
          await doc.ref.update({
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error('Error polling BipBot ingress collection', { err });
    }

    setTimeout(poll, BIPBOT_INGRESS_POLL_INTERVAL);
  };

  log.info('BipBot ingress poller started', { pollInterval: BIPBOT_INGRESS_POLL_INTERVAL });
  setTimeout(poll, 5000);
}
