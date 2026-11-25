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

**This install runs on Linux with systemd user units.** It was migrated from macOS/launchd on
2026-09-08; the launchd plists and `/Users/jeffreythomas/...` paths this section used to list are
gone. Verified 2026-09-16.

Health-check everything: `systemctl --user list-units --type=service 'nanoclaw-*'`

All three units log to the **journal**, not to `logs/*.log` — the units set no
`StandardOutput=`/`StandardError=`, so `logs/` is empty by design. See CLAUDE.md "Logging".

### Main NanoClaw service
- Unit: `nanoclaw-golf.service` (`~/.config/systemd/user/nanoclaw-golf.service`)
- Command: `/home/jthomas/.nvm/versions/node/v22.23.2/bin/node /home/jthomas/nanoclaw-golf/dist/index.js`
- Logs: `journalctl --user -u nanoclaw-golf -f`
- Restart: `pnpm run build && systemctl --user restart nanoclaw-golf`
- Note: the unit name is `nanoclaw-golf`, **not** `nanoclaw`. `systemctl --user is-active nanoclaw`
  returns "inactive" for a service that is running fine.

### Coach API — DEPRECATED, not in use
- Not part of the working stack. Do not treat a failure here as an incident, and do not
  health-check it as part of the runbook.
- It is nonetheless still *running*: the `nanoclaw-golf` unit sets
  `Environment=ENABLE_COACH_AGENT=true` and `Environment=APP_PORT=4317` (these override `.env`),
  so the endpoint answers in-process and `curl http://127.0.0.1:4317/health` returns 200.
- Cleanup, whenever convenient: drop those two `Environment=` lines from
  `~/.config/systemd/user/nanoclaw-golf.service`, then
  `systemctl --user daemon-reload && systemctl --user restart nanoclaw-golf`.
  Left in place for now — retiring it is a separate decision from documenting it.
- **Safe to remove.** Verified 2026-09-16: `ENABLE_COACH_AGENT` gates only
  `startAppBridgeRuntime()` (`src/index.ts:190`), the HTTP server on 4317. The coach *agent
  groups* (`agent-coach-2`, the `coach-*` group folders, the coach-portal MCP wiring) are gated
  separately by agent-group id and folder name in `src/container-runner.ts`, not by this flag.
  Turning the flag off stops the deprecated bridge and leaves the coach agents working.
- Likely bonus: the app server registers an `onShutdown` callback that calls `appServer.close()`.
  Node's `close()` waits for keep-alive connections to drain and is a classic hang source, and
  this unit's stop currently times out and gets SIGKILLed
  (`nanoclaw-golf.service: State 'final-sigterm' timed out. Killing.`). Unconfirmed, but removing
  the flag is the cheapest way to test it.

### Sibling units
- `nanoclaw-headstart.service` — NanoClaw Headstart Host, a separate install at
  `~/clients/headstart/nanoclaw-headstart` (runs from source via tsx, not this repo).
- `nanoclaw-litellm.service` — LiteLLM Hugging Face fallback proxy; runs the
  `ghcr.io/berriai/litellm` container on `127.0.0.1:4000`, config at
  `~/.config/nanoclaw/litellm-config.yaml`.

### Cloudflare tunnel — gone, and expected to be
- `cloudflared` is not running, has no systemd unit, and the old launchd agent
  `com.personal-golf.coach-tunnel` no longer exists.
- `curl https://coach-bridge.golf-tip.org/health` returns 530 (Cloudflare: origin unreachable).
- **This is fine.** The tunnel existed to front the Coach API, which is deprecated. Nothing in the
  working stack depends on it, so the 530 is not an incident.

### Known-stale reference
`script/check-coach-stack.sh` is referenced by older notes but **does not exist** in this repo.
