# Starter Scheduled Tasks — Personal Group

Ask the agent in the personal chat to create these (it calls `schedule_task`),
or adjust times first. All cron times are local (`TIMEZONE`).

## 1. Morning brief — weekdays 7:10am
- schedule: `cron` `10 7 * * 1-5`
- context_mode: `isolated`
- prompt:
  > Read errands.md, people.md, home.md, money.md, health.md and any
  > trips/*.md. Send one Telegram message: today's dated items, anything due
  > in the next 3 days, birthdays in the next 7 days, and the top 3 open
  > errands. Max 8 bullets. If nothing is due, send a one-line "clear day"
  > message.

## 2. Weekly review — Sunday 6:40pm
- schedule: `cron` `40 18 * * 0`
- context_mode: `group`
- prompt:
  > Weekly review. List errands completed this week, errands open more than 14
  > days (ask keep/drop/delegate), next week's dated items, and any renewals or
  > bills due in 30 days from money.md. End with one question about what
  > matters most next week. Record the answer in decisions.md when it arrives.

## 3. Home maintenance sweep — 1st of month 9:05am
- schedule: `cron` `5 9 1 * *`
- context_mode: `isolated`
- prompt:
  > Read home.md. If any recurring maintenance (filters, smoke detectors,
  > gutters, service contracts) is due this month, send a short list with the
  > vendor/contact. Otherwise wrap everything in <internal> and send nothing.

## 4. Stale-thread nudge — daily 5:20pm
- schedule: `cron` `20 17 * * *`
- context_mode: `group`
- prompt:
  > Look at the last 3 days of this chat. If Jeffrey asked for something you
  > couldn't finish or said "remind me"/"later" without a reminder existing,
  > send one line about it. Otherwise send nothing (use <internal>).

These replace the golf check-in engine for this group: they're per-group,
content-aware, and stay silent when there's nothing to say.
