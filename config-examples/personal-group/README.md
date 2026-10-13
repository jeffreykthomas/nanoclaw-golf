# Personal-Life Group (sketch)

A second NanoClaw group for non-golf life: errands, family, home, money,
health, travel. Same host process, same Telegram bot, separate chat, separate
memory.

## Files here

| File | Goes to |
|------|---------|
| `CLAUDE.md` | `groups/telegram_personal/CLAUDE.md` (group memory/persona) |
| `scheduled-tasks.md` | Starter tasks to create from inside the personal chat |

## Setup

1. Create a new Telegram chat with the bot. A private group containing just you
   and the bot works well, so it stays separate from the main DM. Get its
   chat ID with `/chatid`.
2. Register it. It isn't main, and it needs no trigger because only you are in it:

   ```bash
   npx tsx setup/index.ts --step register -- \
     --jid "tg:<chat-id>" --name "Personal" --folder "telegram_personal" \
     --trigger "@Andy" --channel telegram --no-trigger-required
   ```

3. Install the persona. Register already copied `groups/global/CLAUDE.md`, so
   overwrite it:

   ```bash
   cp config-examples/personal-group/CLAUDE.md groups/telegram_personal/CLAUDE.md
   ```

4. Rebuild and restart:
   `npm run build && launchctl kickstart -k gui/$(id -u)/com.personal-golf.nanoclaw-main`
5. In the new chat: "set up the starter tasks from scheduled-tasks.md" (paste
   them in; the container can't see `config-examples/`).

`groups/*` is gitignored, so the live `CLAUDE.md` and data files stay local.
That's intentional for personal data.

## Design notes / what this deliberately does NOT reuse

- **Check-in engine (`src/checkin-engine.ts`)**: it's keyed by `user_id`, not by
  group. It sends through the single Telegram mirror, and the message text is
  hardcoded to "golf coach and life coach". Reusing it here would mean two
  check-ins to one person, or check-ins in the wrong chat. Instead, the
  personal group gets its proactivity from per-group `schedule_task` crons that
  read the group's own files and stay silent when nothing is due.
- **User profile / insights**: `profile/user-profile-schema.json` already covers
  whole-life categories (habits, health, goals, relationships), and
  `user_profile_index` is per-user. Insights saved from this group therefore feed
  the same profile the golf coach reads. The persona limits `<save-insight>` to
  identity-level facts (preferences, values, routines) and keeps logistics out.
  If you'd rather fully separate them, add a source/group tag to insights and
  filter on it in `src/profile/service.ts`.
- **Mounts**: none by default. To give it a real folder (e.g. a synced
  `~/Documents/Personal`), add `containerConfig.additionalMounts` with
  `readonly: true` and allowlist the path in
  `~/.config/nanoclaw/mount-allowlist.json` (see `config-examples/mount-allowlist.json`).

## Gaps worth closing next (in priority order)

1. **Calendar**: there's no calendar skill. This is the biggest missing piece for
   a personal assistant. Simplest route: a Google Calendar MCP server added to
   the container with credentials via OneCLI, read-only first.
2. **Gmail as a tool** (`/add-gmail`, tool mode, not channel mode) for things
   like "find the confirmation for the hotel" and bill due dates.
3. **Voice notes** (`/add-voice-transcription` or `/use-local-whisper`) for
   dumping errands while driving. Note that both currently target WhatsApp, so
   Telegram needs porting.
4. **Transactions**: keep them out of NanoClaw. Use a dedicated computer-use agent
   (e.g. Hark Handoff) for checkouts and bookings, and have this group track the
   resulting confirmations in `trips/` / `money.md`.
