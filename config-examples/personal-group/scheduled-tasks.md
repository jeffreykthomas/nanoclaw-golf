# Starter Scheduled Tasks — Personal Group

Ask the agent in the personal chat to create these (it calls `schedule_task`),
or adjust times first. All cron times are local (`TIMEZONE`).

## 1. Morning brief — weekdays 7:10am
- schedule: `cron` `10 7 * * 1-5`
- context_mode: `isolated`
- prompt:
  > List today's and tomorrow's calendar events. Search Gmail for unread
  > mail from the last 24h that needs action (bills, deadlines, RSVPs, school,
  > deliveries); ignore promotions and newsletters. Read errands.md,
  > people.md, home.md, money.md, health.md and any trips/*.md. Send one
  > Telegram message: today's schedule, anything due in the next 3 days,
  > emails needing action (sender + one line), birthdays in the next 7 days,
  > and the top 3 open errands. Max 10 bullets. File any new due dates you
  > found in email into the right workspace file.

## 2. Weekly review — Sunday 6:40pm
- schedule: `cron` `40 18 * * 0`
- context_mode: `group`
- prompt:
  > Weekly review. Summarize next week's calendar (flag conflicts and days
  > with no breaks). List errands completed this week, errands open more than 14
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

## 4. Bill and renewal scan — Mondays 8:10am
- schedule: `cron` `10 8 * * 1`
- context_mode: `isolated`
- prompt:
  > Search Gmail from the last 8 days for bills, statements, renewals and
  > subscription charges. Add any new due dates/amounts to money.md (no
  > account numbers). If anything is due within 10 days and not already in
  > money.md, send a short list; otherwise send nothing (use <internal>).

## 5. Stale-thread nudge — daily 5:20pm
- schedule: `cron` `20 17 * * *`
- context_mode: `group`
- prompt:
  > Look at the last 3 days of this chat. If Jeffrey asked for something you
  > couldn't finish or said "remind me"/"later" without a reminder existing,
  > send one line about it. Otherwise send nothing (use <internal>).

These replace the golf check-in engine for this group: they're per-group,
content-aware, and stay silent when there's nothing to say.
