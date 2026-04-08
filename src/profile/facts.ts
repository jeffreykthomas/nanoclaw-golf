import { createHash } from 'crypto';

import type { ProfileFact, ProfileFactCategory } from './types.js';

function makeFactId(parts: string[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function pushFact(
  facts: ProfileFact[],
  params: {
    at: string;
    source: 'user_message' | 'coach_context';
    category: ProfileFactCategory;
    fact: string;
    evidence: string;
  },
): void {
  const fact = params.fact.trim();
  const evidence = params.evidence.trim();
  if (!fact || !evidence) return;
  facts.push({
    id: makeFactId([
      params.category,
      fact.toLowerCase(),
      evidence.toLowerCase(),
    ]),
    at: params.at,
    source: params.source,
    category: params.category,
    fact,
    evidence,
  });
}

function extractFromMessage(message: string, at: string): ProfileFact[] {
  const facts: ProfileFact[] = [];
  const lower = message.trim().toLowerCase();

  const add = (category: ProfileFactCategory, fact: string) =>
    pushFact(facts, {
      at,
      source: 'user_message',
      category,
      fact,
      evidence: message,
    });

  const patterns: Array<{
    category: ProfileFactCategory;
    regex: RegExp;
    prefix?: string;
  }> = [
    {
      category: 'demographics',
      regex: /\b(i am|i'm)\s+(\d{1,3})\b/i,
      prefix: 'age ',
    },
    {
      category: 'location',
      regex: /\b(i live in|i'm in|i am in|based in)\s+([^.,;!?\n]+)/i,
      prefix: 'lives in ',
    },
    {
      category: 'location',
      regex: /\b(i am from|i'm from)\s+([^.,;!?\n]+)/i,
      prefix: 'from ',
    },
    {
      category: 'work',
      regex: /\b(i work as|i work at|my job is)\s+([^.,;!?\n]+)/i,
      prefix: '',
    },
    {
      category: 'preference',
      regex: /\b(i like|i love|i enjoy|i prefer)\s+([^.,;!?\n]+)/i,
      prefix: '',
    },
    {
      category: 'preference',
      regex: /\b(i dislike|i hate|i do not like|i don't like)\s+([^.,;!?\n]+)/i,
      prefix: 'dislikes ',
    },
    {
      category: 'goal',
      regex:
        /\b(i want to|i hope to|i'm trying to|i am trying to)\s+([^.,;!?\n]+)/i,
      prefix: '',
    },
    {
      category: 'value',
      regex:
        /\b(i value|what matters to me is|it is important to me to)\s+([^.,;!?\n]+)/i,
      prefix: '',
    },
    {
      category: 'strength',
      regex:
        /\b(i am good at|i'm good at|my strength is|people rely on me for)\s+([^.,;!?\n]+)/i,
      prefix: '',
    },
    {
      category: 'weakness',
      regex:
        /\b(i struggle with|i'm bad at|i am bad at|my weakness is)\s+([^.,;!?\n]+)/i,
      prefix: '',
    },
    {
      category: 'constraint',
      regex:
        /\b(i can't|i cannot|i do not have time to|i don't have time to)\s+([^.,;!?\n]+)/i,
      prefix: '',
    },
    {
      category: 'relationship',
      regex:
        /\b(i have|my)\s+([^.,;!?\n]*(wife|husband|partner|kids|children|dog|cat|family)[^.,;!?\n]*)/i,
      prefix: '',
    },
    {
      category: 'identity',
      regex: /\b(i am|i'm)\s+(a|an)\s+([^.,;!?\n]+)/i,
      prefix: '',
    },
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern.regex);
    if (!match) continue;
    const factText = pattern.prefix
      ? `${pattern.prefix}${match[match.length - 1].trim()}`
      : match[match.length - 1].trim();
    add(pattern.category, factText);
  }

  if (
    /\bgolf|round|driver|putter|wedge|handicap|tee shot|approach|short game|strokes gained\b/i.test(
      lower,
    )
  ) {
    add('golf', lower.slice(0, 160));
  }

  if (/\bpriority|prioritize|most important\b/i.test(lower)) {
    add('priority', lower.slice(0, 160));
  }

  if (/\bpain|injury|back|shoulder|knee|sleep|anxiety|stress\b/i.test(lower)) {
    add('health', lower.slice(0, 160));
  }

  if (/\bdirect|blunt|sensitive|conflict|argument|communicat/i.test(lower)) {
    add('communication', lower.slice(0, 160));
  }

  return dedupeFacts(facts);
}

function stringifyContextValue(value: unknown): string | null {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const scalars = value
      .filter(
        (item) =>
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean',
      )
      .map(String);
    return scalars.length > 0 ? scalars.join(', ') : null;
  }
  return null;
}

function categoryForContextKey(key: string): ProfileFactCategory {
  const normalized = key.toLowerCase();
  if (
    /(golf|club|round|score|shot|swing|putt|course|handicap)/.test(normalized)
  ) {
    return 'golf';
  }
  if (/(goal|target|aim)/.test(normalized)) return 'goal';
  if (/(preference|like|dislike)/.test(normalized)) return 'preference';
  if (/(strength|weakness)/.test(normalized))
    return normalized.includes('weak') ? 'weakness' : 'strength';
  if (/(constraint|availability|injury|pain|mobility)/.test(normalized)) {
    return normalized.includes('injury') || normalized.includes('pain')
      ? 'health'
      : 'constraint';
  }
  return 'other';
}

function extractFromContext(
  context: Record<string, unknown>,
  at: string,
): ProfileFact[] {
  const facts: ProfileFact[] = [];
  for (const [key, value] of Object.entries(context)) {
    const stringValue = stringifyContextValue(value);
    if (!stringValue) continue;
    pushFact(facts, {
      at,
      source: 'coach_context',
      category: categoryForContextKey(key),
      fact: `${key}: ${stringValue}`,
      evidence: `${key}=${stringValue}`,
    });
  }
  return dedupeFacts(facts);
}

export function extractProfileFacts(params: {
  message: string;
  context: Record<string, unknown>;
  at?: string;
}): ProfileFact[] {
  const at = params.at ?? new Date().toISOString();
  return dedupeFacts([
    ...extractFromMessage(params.message, at),
    ...extractFromContext(params.context, at),
  ]);
}

export function dedupeFacts(facts: ProfileFact[]): ProfileFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.category}:${fact.fact.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
