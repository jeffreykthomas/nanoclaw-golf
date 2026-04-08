import fs from 'fs/promises';
import path from 'path';

import { DATA_DIR } from '../config.js';
import type { ProfileFact, UserProfileDocument } from './types.js';

function userDir(userId: string): string {
  return path.join(DATA_DIR, 'user-profiles', userId);
}

function profilePath(userId: string): string {
  return path.join(userDir(userId), 'profile.json');
}

function factsPath(userId: string): string {
  return path.join(userDir(userId), 'facts.jsonl');
}

function reportPath(userId: string): string {
  return path.join(userDir(userId), 'latest-report.md');
}

function summaryPath(userId: string): string {
  return path.join(userDir(userId), 'summary.txt');
}

async function ensureDir(userId: string): Promise<void> {
  await fs.mkdir(userDir(userId), { recursive: true });
}

export async function loadUserProfileDocument(
  userId: string,
): Promise<UserProfileDocument | null> {
  try {
    const raw = await fs.readFile(profilePath(userId), 'utf8');
    return JSON.parse(raw) as UserProfileDocument;
  } catch {
    return null;
  }
}

export async function writeUserProfileDocument(
  userId: string,
  profile: UserProfileDocument,
): Promise<void> {
  await ensureDir(userId);
  await fs.writeFile(
    profilePath(userId),
    `${JSON.stringify(profile, null, 2)}\n`,
    'utf8',
  );
}

export async function loadProfileFacts(
  userId: string,
  limit?: number,
): Promise<ProfileFact[]> {
  try {
    const raw = await fs.readFile(factsPath(userId), 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const parsed = lines.map((line) => JSON.parse(line) as ProfileFact);
    if (!limit || parsed.length <= limit) return parsed;
    return parsed.slice(parsed.length - limit);
  } catch {
    return [];
  }
}

export async function appendProfileFacts(
  userId: string,
  facts: ProfileFact[],
): Promise<void> {
  if (facts.length === 0) return;
  await ensureDir(userId);
  const payload = facts.map((fact) => JSON.stringify(fact)).join('\n');
  await fs.appendFile(factsPath(userId), `${payload}\n`, 'utf8');
}

export async function writeProfileReport(
  userId: string,
  report: string,
): Promise<void> {
  await ensureDir(userId);
  await fs.writeFile(reportPath(userId), report, 'utf8');
}

export async function readProfileReport(
  userId: string,
): Promise<string | null> {
  try {
    return await fs.readFile(reportPath(userId), 'utf8');
  } catch {
    return null;
  }
}

export async function writeCompactProfileSummary(
  userId: string,
  summary: string,
): Promise<void> {
  await ensureDir(userId);
  await fs.writeFile(summaryPath(userId), summary, 'utf8');
}

export async function readCompactProfileSummary(
  userId: string,
): Promise<string | null> {
  try {
    return await fs.readFile(summaryPath(userId), 'utf8');
  } catch {
    return null;
  }
}
