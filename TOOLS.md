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

Three launch agents make up the local stack. Health-check them all with `script/check-coach-stack.sh`.

### Main NanoClaw service
- Plist: `~/Library/LaunchAgents/com.personal-golf.nanoclaw-main.plist`
- Label: `com.personal-golf.nanoclaw-main`
- Command: `/Users/jeffreythomas/.nvm/versions/node/v22.14.0/bin/node /Users/jeffreythomas/nanoclaw-golf/dist/index.js`
- Logs: `logs/nanoclaw.log` and `logs/nanoclaw.error.log`
- Restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.personal-golf.nanoclaw-main`

### Coach API (Rails app + sibling bridge)
- Plist: `~/Library/LaunchAgents/com.personal-golf.coach-api.plist`
- Label: `com.personal-golf.coach-api`
- Command: `npm run dev:app` (port `4317`, `ENABLE_COACH_AGENT=true`)
- Logs: `~/Library/Logs/personal-golf-coach-api.{out,err}.log`
- Restart: `launchctl kickstart -k gui/$(id -u)/com.personal-golf.coach-api`
- Health: `curl http://127.0.0.1:4317/health`

### Cloudflare tunnel
- Plist: `~/Library/LaunchAgents/com.personal-golf.coach-tunnel.plist`
- Label: `com.personal-golf.coach-tunnel`
- Command: `cloudflared tunnel --config ~/.cloudflared/config.yml run personal-golf-coach`
- Logs: `~/Library/Logs/personal-golf-coach-tunnel.{out,err}.log`
- Restart: `launchctl kickstart -k gui/$(id -u)/com.personal-golf.coach-tunnel`
- Health: `curl https://coach-bridge.golf-tip.org/health`
