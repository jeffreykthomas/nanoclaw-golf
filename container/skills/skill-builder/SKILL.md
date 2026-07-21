---
name: skill-builder
description: Create or update your own learned skills — durable, reusable procedures stored as SKILL.md files in your workspace. Use when you've worked out a multi-step operational procedure worth keeping, when an existing skill's instructions turn out to be wrong or stale mid-task, or when the user asks you to remember how to do something.
---

# Skill Builder

Your learned skills live at `/workspace/agent/.claude/skills/<name>/SKILL.md`. They persist on the host per agent group and load through the Claude skill system — the same mechanism as the shared skills in `~/.claude/skills/`, but writable by you.

## When to create a skill

Create one when a task is **operational and repeatable**: it has concrete steps, real endpoints/collections/commands, and will plausibly be asked again. Examples: sending a bulk email campaign, publishing a blog post, generating a monthly report, deploying a site.

Do NOT create a skill for one-off work, general knowledge, or user preferences (those go in `CLAUDE.local.md`).

## Format

```
/workspace/agent/.claude/skills/<kebab-case-name>/
  SKILL.md          ← required
  <helper files>    ← optional: scripts, templates, reference docs
```

`SKILL.md` starts with YAML frontmatter:

```markdown
---
name: mass-email
description: One or two sentences saying WHAT this does and WHEN to use it. This is the only part always visible — make it specific enough that you'll match it to the right requests.
---

# Title

**Current mechanism (verified YYYY-MM-DD):** one-line summary of the working path.

## Steps
...concrete, copy-pasteable steps...

## Environment constraints
...things that bit you: "no python in this container", "SES keys live in Firebase, not env", etc...

## Safety rails
...approval gates, dedup checks, things that must never be automated...
```

Conventions that matter:

- **Date-stamp verification.** Write `verified 2026-07-06` next to the mechanism. When you successfully use the skill again, bump the date. When the user tells you a mechanism changed, rewrite the section — don't append a correction below stale instructions.
- **Keep legacy paths clearly buried.** If an old approach must be kept for context, put it at the bottom under a `## LEGACY (do not use)` header. Never leave two candidate mechanisms at the same prominence — that's how a stale runbook gets followed.
- **Record environment constraints** the moment you hit them, so the next session doesn't rediscover them.
- **Put reusable scripts in the skill folder**, not `/tmp` (which is wiped). Reference them from SKILL.md by path.

## Updating mid-task (important)

Skill edits **hot-reload within your running session** — you don't need a restart. So when a step fails or the user corrects you:

1. Fix the SKILL.md right then, as part of handling the correction — not as cleanup at the end (sessions end unpredictably; end-of-task cleanup often never happens).
2. Note that an invoked skill's content is already in your context — your own edit won't re-inject it, but you just wrote it, so you know it. The fix is for the *next* invocation.

New skill folders you create under `.claude/skills/` are also picked up live (the directory is pre-created before your session starts, so the watcher is active).

## Relationship to other memory

- `CLAUDE.local.md` — always-loaded per-group memory: preferences, people, project context, pointers. Keep a one-line pointer there to each skill you create ("mass email → invoke the `mass-email` skill").
- `docs/`, `REFLECTIONS.md`, ledgers — narrative and history. Fine to keep, but the **procedure of record** is the skill; docs should point at it, not duplicate it.
- Shared skills in `~/.claude/skills/` are read-only (host-managed). Yours live in `/workspace/agent/.claude/skills/`.
