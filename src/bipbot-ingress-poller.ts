import fs from 'fs';

import type { ServiceAccount } from 'firebase-admin/app';

import { extractBipbotTargetBranch } from './bipbot-branch.js';
import { BIPBOT_INGRESS_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';

export interface BipbotIngressEvent {
  docId: string;
  jobId: string;
  issueId: string;
  issueUrl: string;
  branch: string | null;
  prompt: string;
  sourceType: string;
  actor?: Record<string, unknown>;
}

export interface BipbotIngressPollerDeps {
  onIngressEvent: (event: BipbotIngressEvent) => Promise<void>;
}

let pollerRunning = false;

export async function startBipbotIngressPoller(
  serviceAccountPath: string,
  deps: BipbotIngressPollerDeps,
): Promise<void> {
  if (pollerRunning) {
    logger.debug('BipBot ingress poller already running');
    return;
  }
  pollerRunning = true;

  let appModule: typeof import('firebase-admin/app');
  let firestoreModule: typeof import('firebase-admin/firestore');
  try {
    appModule = await import('firebase-admin/app');
    firestoreModule = await import('firebase-admin/firestore');
  } catch (err) {
    logger.error(
      { err },
      'firebase-admin not installed. Run: npm install firebase-admin',
    );
    pollerRunning = false;
    return;
  }

  let serviceAccount: Record<string, unknown>;
  try {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));
  } catch (err) {
    logger.error(
      { err, path: serviceAccountPath },
      'Failed to read BipBot Firebase service account',
    );
    pollerRunning = false;
    return;
  }

  const appName = 'bipbot-ingress';
  const app =
    appModule.getApps().find((existing) => existing.name === appName) ||
    appModule.initializeApp(
      { credential: appModule.cert(serviceAccount as ServiceAccount) },
      appName,
    );
  const db = firestoreModule.getFirestore(app);
  const collection = db.collection('nanoClawIngress');

  const poll = async () => {
    try {
      const snapshot = await collection
        .where('status', '==', 'queued')
        .limit(10)
        .get();
      if (snapshot.empty) {
        setTimeout(poll, BIPBOT_INGRESS_POLL_INTERVAL);
        return;
      }

      for (const doc of snapshot.docs.slice(0, 1)) {
        try {
          const claimed = await db.runTransaction(
            async (txn: FirebaseFirestore.Transaction) => {
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
            },
          );
          if (!claimed) continue;

          const data = doc.data();
          const prompt = String(data.prompt || '');
          const explicitBranch =
            typeof data.branch === 'string' && data.branch.trim()
              ? data.branch.trim()
              : null;
          const event: BipbotIngressEvent = {
            docId: doc.id,
            jobId: String(data.jobId || doc.id),
            issueId: String(data.issueId || doc.id),
            issueUrl: String(data.issueUrl || ''),
            branch: explicitBranch || extractBipbotTargetBranch(prompt),
            prompt,
            sourceType: String(data.sourceType || 'bipbot'),
            actor:
              data.actor && typeof data.actor === 'object'
                ? (data.actor as Record<string, unknown>)
                : undefined,
          };

          await deps.onIngressEvent(event);
          await doc.ref.update({
            status: 'processed',
            processedAt: new Date().toISOString(),
          });
        } catch (err) {
          logger.error(
            { docId: doc.id, err },
            'Failed to process BipBot ingress doc',
          );
          await doc.ref.update({
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error polling BipBot ingress collection');
    }

    setTimeout(poll, BIPBOT_INGRESS_POLL_INTERVAL);
  };

  logger.info(
    { pollInterval: BIPBOT_INGRESS_POLL_INTERVAL },
    'BipBot ingress poller started',
  );
  setTimeout(poll, 5000);
}
