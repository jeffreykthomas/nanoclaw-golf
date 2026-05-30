/**
 * Sanitize outbound text for Telegram's legacy `Markdown` parse mode.
 *
 * WORKAROUND: The @chat-adapter/telegram adapter hardcodes parse_mode=Markdown
 * (legacy) but its converter emits CommonMark. Messages with `**bold**`, odd
 * delimiter counts, or malformed links are rejected by Telegram and dropped
 * after retries. Remove this once upstream ships real mode-aware conversion
 * (vercel/chat PR #367 adds the knob; a follow-up is needed for the converter).
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function formatMarkdownTable(lines: string[]): string {
  const rows = lines.filter((_, index) => index !== 1).map(splitMarkdownTableRow);
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );

  return rows
    .map((row) =>
      Array.from({ length: columnCount }, (_, column) => (row[column] ?? '').padEnd(widths[column]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function codeFenceMarkdownTables(input: string): string {
  const lines = input.split('\n');
  const output: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      output.push(line);
      continue;
    }

    if (!inFence && i + 1 < lines.length && isMarkdownTableRow(line) && isMarkdownTableSeparator(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isMarkdownTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      output.push(`\`\`\`\n${formatMarkdownTable(tableLines)}\n\`\`\``);
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

export function sanitizeTelegramLegacyMarkdown(input: string): string {
  if (!input) return input;

  const codeSegments: string[] = [];
  let text = codeFenceMarkdownTables(input).replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // The adapter re-parses and re-stringifies markdown before sending, which
  // rewrites `- item` list bullets into `* item` — injecting unbalanced
  // asterisks that Telegram's legacy Markdown parser then rejects. Replace
  // list bullets with a plain Unicode bullet so the adapter treats the line
  // as prose.
  text = text.replace(/^(\s*)[-+]\s+/gm, '$1• ');

  // Flatten Markdown horizontal rules (bare --- / *** / ___ lines) to a
  // plain Unicode divider. The parser doesn't understand HR syntax and the
  // `*` / `_` characters would otherwise unbalance the delimiter counts below.
  text = text.replace(/^[ \t]*[-_*]{3,}[ \t]*$/gm, '⎯⎯⎯');

  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  text = text.replace(/__([^_\n]+?)__/g, '_$1_');

  const starCount = (text.match(/\*/g) ?? []).length;
  const underCount = (text.match(/_/g) ?? []).length;
  if (starCount % 2 !== 0 || underCount % 2 !== 0) {
    text = text.replace(/[*_]/g, '');
  }

  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/\]/g) ?? []).length;
  if (openBrackets !== closeBrackets) {
    text = text.replace(/[[\]]/g, '');
  }

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
