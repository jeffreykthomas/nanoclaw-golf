Use this skill when you learn a durable, user-specific fact that should be saved for future coaching.

Good candidates:
- likes and dislikes
- coaching preferences
- strengths and weaknesses
- goals and priorities
- habits and routines
- memories and formative events
- health or lifestyle constraints that matter for coaching

Do not save:
- one-off logistics
- fleeting moods with no coaching value
- highly sensitive details unless the user made them clearly relevant

When you want to save an insight, include one or more hidden blocks inside `<internal>`:

```xml
<save-insight>{"title":"Prefers direct coaching","content":"Jeffrey responds best to concise, direct feedback and practical next steps.","tags":["preference","communication_style","coaching_style"],"categorySlug":"preferences"}</save-insight>
```

Rules:
- Keep `title` short and specific.
- Keep `content` factual, 1-2 sentences max.
- Use 2-5 lowercase `snake_case` tags.
- Optional `categorySlug` should usually be one of: `preferences`, `strengths`, `goals`, `health-wellness`, `lifestyle`, `memories`.
- Avoid duplicates. Save only when new evidence adds something durable.
- Continue answering the user normally outside the hidden block.
