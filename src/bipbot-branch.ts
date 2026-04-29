const BRANCH_NAME_PATTERN = '[A-Za-z0-9._/-]+';

export function extractBipbotTargetBranch(prompt: string): string | null {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) return null;

  const bangBranchMatch = trimmedPrompt.match(
    new RegExp(`^!(${BRANCH_NAME_PATTERN})$`, 'm'),
  );
  if (bangBranchMatch) return bangBranchMatch[1];

  const sentenceBranchMatchers = [
    new RegExp(
      `\\bThis code lives on the\\s+\`(${BRANCH_NAME_PATTERN})\`\\s+branch\\b`,
      'i',
    ),
    new RegExp(`\\bOn the\\s+\`(${BRANCH_NAME_PATTERN})\`\\s+branch\\b`, 'i'),
    new RegExp(
      `\\bcheck out\\s+\`(${BRANCH_NAME_PATTERN})\`\\s*,?\\s*not\\s+\`main\`\\b`,
      'i',
    ),
  ];

  for (const matcher of sentenceBranchMatchers) {
    const match = trimmedPrompt.match(matcher);
    if (match) return match[1];
  }

  return null;
}
