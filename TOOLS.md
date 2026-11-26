# TOOLS.md - Coaching Toolkit Notes

Keep practical coaching references here (non-secret).

## Data Sources
- Arccos dashboard data (rounds + category trends)
- Session notes in `memory/YYYY-MM-DD.md`
- Long-term context in `MEMORY.md`

## Coaching Framework
1. Diagnose
   - find the weakest current category (putting, short game, approach, driving)
2. Prescribe
   - one priority drill
   - one on-course decision rule
3. Reinforce
   - one simple metric to track next round/week

## Useful Coaching Prompts
- "Give me one swing-thought for today."
- "What should I focus on for my next 30-minute practice?"
- "What is the safest strategy on holes where I make doubles?"
- "Summarize my last rounds and give me one priority for each category."

## Communication Style
- concise and specific
- no fluff
- prioritize next action over explanation

## Local Service Runbook

**This install runs on the Mac under launchd.** Verified 2026-10-12.

History, because older notes disagree: Mac (launchd) → Lambda (`/home/jthomas`, systemd user
units) on 2026-09-08 → back to the Mac on 2026-09-20. Any note mentioning `systemctl`,
`journalctl`, `nanoclaw-golf.service` or `/home/jthomas` describes the Lambda period and does not
apply here. The Lambda copy is stale and its service is disabled; don't start it without
reconciling state. Migration notes, rollback steps and prior plists:
`~/nanoclaw-golf-migration-20260920/README.md`. Pre-migration backup:
`~/nanoclaw-golf.pre-migration-20260920`.

Health check: `launchctl list | grep personal-golf` (expect only `nanoclaw-main`, with a PID and
exit status 0).

### Main NanoClaw service
- Plist: `~/Library/LaunchAgents/com.personal-golf.nanoclaw-main.plist`
- Label: `com.personal-golf.nanoclaw-main`
- Command: `/bin/bash ~/nanoclaw-golf-migration-20260920/start-golf.sh`. The wrapper starts the
  `nanoclaw-golf` Colima profile if Docker is down, starts the `nanoclaw-golf-telegram-api`
  container, then `exec node dist/index.js` (Node v22.22.2 via nvm).
- Docker context: `colima-nanoclaw-golf` (set in the plist env). Plain `docker` in a shell may hit a
  different context; pass `--context colima-nanoclaw-golf` if `docker ps` looks empty.
- Logs: `logs/nanoclaw.log` (full routing chain) and `logs/nanoclaw.error.log` (warnings and
  errors), via the plist's `StandardOutPath`/`StandardErrorPath`.
- Restart: `pnpm run build && launchctl kickstart -k gui/$(id -u)/com.personal-golf.nanoclaw-main`

### Local Telegram Bot API
- Container `nanoclaw-golf-telegram-api` (`aiogram/telegram-bot-api`), `127.0.0.1:8081`, run in
  `--local` mode. `.env` sets `TELEGRAM_API_ROOT=http://127.0.0.1:8081`.
- Data dir: `data/telegram-api-migrated` is bind-mounted at `/var/lib/telegram-bot-api`.
  `TELEGRAM_BOT_API_DATA` in `.env` **must** name the same dir. The host uses it to turn the
  server's `/var/lib/telegram-bot-api/...` file paths into host paths, and
  `scripts/run-telegram-bot-api.sh` uses it as the mount source. If the two disagree, every
  inbound photo or file fails with `ENOENT` ("Failed to download Telegram attachment") and the agent
  gets the message without the media. `data/telegram-bot-api` is the pre-migration dir; it is
  stale and no longer used.
- Check the mount: `docker inspect nanoclaw-golf-telegram-api --format '{{json .Mounts}}'`

### Coach API — DEPRECATED, not in use
- Not part of the working stack. Don't treat a failure here as an incident, and don't
  health-check it as part of the runbook.
- It's still *running* in-process: the main plist's `EnvironmentVariables` set
  `ENABLE_COACH_AGENT=true` and `APP_PORT=4317`, overriding `.env` (which has `false` / `3100`).
  So `curl http://127.0.0.1:4317/health` returns 200.
- The standalone `com.personal-golf.coach-api` launch agent (old `npm run dev:app` from
  `~/Documents/personal-golf/...`) still has a plist in `~/Library/LaunchAgents` but is
  **disabled** in launchd and not loaded.
- Safe to retire: `ENABLE_COACH_AGENT` gates only `startAppBridgeRuntime()` (`src/index.ts:190`),
  the HTTP server on 4317. The coach *agent groups* (`agent-coach-2`, the `coach-*` group folders,
  the coach-portal MCP wiring) are gated separately in `src/container-runner.ts`. To retire it,
  remove those two keys from the plist, then `launchctl bootout gui/$(id -u)/com.personal-golf.nanoclaw-main`
  and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.personal-golf.nanoclaw-main.plist`.
  `kickstart` alone does not reread plist env. Not done yet; retiring it is a separate decision.

### Cloudflare tunnel — retired, and expected to be
- `com.personal-golf.coach-tunnel` still has a plist but is **disabled** in launchd; `cloudflared`
  isn't running. The public coach endpoint was retired at the user's request on 2026-09-20.
- `curl https://coach-bridge.golf-tip.org/health` returning 530 is expected, not an incident.

### Lambda leftovers (not this machine)
- `nanoclaw-headstart` and `nanoclaw-litellm` (LiteLLM proxy on Lambda's `127.0.0.1:4000`) were
  left running on Lambda as systemd units. They're not part of this install.

### Known-stale reference
`script/check-coach-stack.sh` is referenced by older notes but **does not exist** in this repo.
