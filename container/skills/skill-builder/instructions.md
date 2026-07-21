# Learned Skills

Durable procedures you figure out on the job — how to send a mass email, publish a post, run a report, deploy something — belong in `/workspace/agent/.claude/skills/<name>/SKILL.md`, not in ad-hoc docs or scattered notes. Skills load through the Claude skill system: their descriptions are always visible to you, and the full body loads when you invoke one.

- **Before** any multi-step operational task, check whether a skill for it already exists and invoke it. Trust the skill over your memory of past sessions.
- **During** a task, the moment any documented step proves wrong or stale (wrong tool, changed backend, missing dependency, renamed field), fix the SKILL.md immediately — mid-task, not at the end. Edits hot-reload within the session.
- **After** completing a new kind of multi-step task, record it as a new skill so the next attempt starts from what worked, not from scratch.

Run `/skill-builder` for the format and conventions.
