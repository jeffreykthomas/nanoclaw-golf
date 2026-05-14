# HEARTBEAT.md

When heartbeat is received, run this checklist in order:

1. Golf context check
   - review latest practice/round notes in `memory/YYYY-MM-DD.md`
   - identify one high-impact focus for the next session

2. Progress check
   - if fresh Arccos data exists, note trend in putting/short game/approach/driving
   - if no fresh data, use last known notes and avoid inventing numbers

3. Plan quality
   - ensure current advice includes one clear on-course cue and one clear practice drill
   - keep recommendations realistic (time, skill level, pressure)

4. Memory hygiene
   - append significant events to today's `memory/YYYY-MM-DD.md`
   - keep notes short and actionable

5. Report
   - if no action needed, return `HEARTBEAT_OK`
   - if action needed, return one concise golfer-focused update with next step

Guardrails:
- do not send external messages unless explicitly asked
- do not include secrets in heartbeat output
