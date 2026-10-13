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
2. Register it. It isn't main, and it needs no trigger because only you are in
   it. Turn on read-only Gmail and Calendar (see "Google setup" below first):

   ```bash
   npx tsx setup/index.ts --step register -- \
     --jid "tg:<chat-id>" --name "Personal" --folder "telegram_personal" \
     --trigger "@Andy" --channel telegram --no-trigger-required \
     --integrations gmail:read,calendar:read
   ```

   `--integrations` accepts `gmail`, `calendar`, each `:read` (default) or
   `:full`. Pass `--integrations ""` to turn both off. Re-running register
   without the flag keeps whatever was set before.

3. Install the persona. Register already copied `groups/global/CLAUDE.md`, so
   overwrite it:

   ```bash
   cp config-examples/personal-group/CLAUDE.md groups/telegram_personal/CLAUDE.md
   ```

4. Rebuild the container (it now ships the Gmail/Calendar MCP servers), then
   the host, then restart:

   ```bash
   ./container/build.sh
   npm run build && launchctl kickstart -k gui/$(id -u)/com.personal-golf.nanoclaw-main
   ```
5. In the new chat: "set up the starter tasks from scheduled-tasks.md" (paste
   them in; the container can't see `config-examples/`).

## Google setup (one time)

Both integrations use one Google Cloud OAuth client.

1. In https://console.cloud.google.com, create or pick a project, then
   **APIs & Services → Library** and enable **Gmail API** and **Google Calendar API**.
2. **OAuth consent screen**: External, add yourself as a test user, then
   **Publish app** (to production). Leaving it in *Testing* makes refresh
   tokens expire every 7 days. An unverified personal app is fine; click
   through the warning when you authorize.
3. **Credentials → Create OAuth client ID → Desktop app** → download JSON.
4. Authorize each one on the Mac. A browser opens each time:

   ```bash
   KEYS=~/Downloads/client_secret_*.json   # the file you downloaded

   mkdir -p ~/.gmail-mcp && cp $KEYS ~/.gmail-mcp/gcp-oauth.keys.json
   npx -y @gongrzhe/server-gmail-autoauth-mcp@1.1.11 auth
   ls ~/.gmail-mcp/credentials.json

   mkdir -p ~/.calendar-mcp && cp $KEYS ~/.calendar-mcp/gcp-oauth.keys.json
   GOOGLE_OAUTH_CREDENTIALS=~/.calendar-mcp/gcp-oauth.keys.json \
   GOOGLE_CALENDAR_MCP_TOKEN_PATH=~/.calendar-mcp/tokens.json \
     npx -y @cocal/google-calendar-mcp@2.7.0 auth
   ls ~/.calendar-mcp/tokens.json
   ```

   If you already ran `/add-gmail` in OneCLI mode, `~/.gmail-mcp` already holds
   OneCLI stub credentials. Leave them alone and skip the Gmail half.

### How access is enforced

- Credentials are mounted only into containers for groups that list the
  integration in `containerConfig.integrations`, and only when the sender is
  the owner (`owner-full`). Other groups, including golf, never see them. If
  the credential file is missing, the integration is skipped with a warning
  in the log.
- **Calendar `read`**: the server only exposes list/search/get/free-busy tools
  (its `ENABLED_TOOLS` filter).
- **Gmail `read`**: send, modify, delete, label and filter tools are removed
  with the SDK's `disallowedTools`. Drafts are still allowed. `full` is
  needed for sending.
- Both OAuth tokens have write scopes (`gmail.modify`, `calendar`), because
  those are what the servers request. `read` is enforced inside NanoClaw, not
  at Google. The tokens sit on your Mac and in the containers of opted-in
  groups.
  So treat `read` as a guardrail against mistakes, not a security boundary.
  An agent with Bash in that container could read the token, or edit its
  per-group agent-runner copy, and call Google directly. Real read-only
  access would need a read-scoped OAuth client, or brokering through OneCLI.
- Both MCP servers are pinned in `container/Dockerfile`. The Gmail read-only
  list is tied to that version's tool names, so recheck
  `container/agent-runner/src/integrations.ts` if you bump it.

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

1. **Voice notes** (`/add-voice-transcription` or `/use-local-whisper`) for
   dumping errands while driving. Note that both currently target WhatsApp, so
   Telegram needs porting.
2. **Gmail as a channel** (incoming mail can trigger the agent) via
   `/add-gmail` channel mode, if the morning brief's email scan isn't enough.
3. **Transactions**: keep them out of NanoClaw. Use a dedicated computer-use agent
   (e.g. Hark Handoff) for checkouts and bookings, and have this group track the
   resulting confirmations in `trips/` / `money.md`.
