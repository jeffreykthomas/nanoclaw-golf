/**
 * PreCompact hook script — outputs custom compaction instructions to stdout.
 *
 * Claude Code captures the stdout of PreCompact shell hooks and passes it
 * as `customInstructions` to the compaction prompt. This ensures the
 * compaction summary preserves message routing context that the agent needs
 * to correctly address responses.
 *
 * Invoked by the PreCompact hook in .claude-shared/settings.json:
 *   "command": "bun /app/src/compact-instructions.ts"
 */
import { getAllDestinations } from './destinations.js';

const destinations = getAllDestinations();
const names = destinations.map((d) => d.name);

const instructions = [
  'Preserve the following in the compaction summary:',
  '',
  '1. For recent LIVE chat/task/webhook turns only, keep the XML structure including attributes:',
  '   - <message from="..." sender="..." time="..."> for chat messages',
  '   - <task from="..." time="..."> for scheduled tasks',
  '   - <webhook from="..." source="..." event="..."> for webhooks',
  '   The message content can be summarized if long, but the XML tags and attributes must remain.',
  '',
  '2. Preserve the chronological message/reply sequence of those recent live exchanges.',
  '   The agent needs to see: who said what, in what order, and from which destination.',
  '',
  '3. Do NOT copy prior compaction summaries, "session is being continued" blocks,',
  '   conversations/ file contents, or large tool/log dumps into the new summary.',
  '   Summarize only the live user/assistant turns since the last compact.',
  '',
  '4. After compact, do not re-read conversations/ or large json/log files.',
  '   Prefer CLAUDE.local.md, ledgers, and a Grep for a specific date/topic.',
  '',
  '5. At the END of the compaction summary, include this verbatim reminder:',
  '   "You MUST wrap all responses in <message to="name">...</message> blocks.',
  `   Available destinations: ${names.length > 0 ? names.map((n) => `\`${n}\``).join(', ') : '(none)'}."`,
];

console.log(instructions.join('\n'));
