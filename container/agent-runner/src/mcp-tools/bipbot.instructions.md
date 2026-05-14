# BipBot Gateway Tools

When handling BipBot ingress, use the BipBot gateway tools for all downstream actions. Do not create branches, push code, open pull requests, or write to Linear directly from the container.

- Use `bipbot_create_codex_job` when an issue should become an implementation job.
- Use `bipbot_enqueue_linear_comment` when the issue should receive a status or audit comment.
- Use `bipbot_upsert_proposal` and `bipbot_record_decision` when the workflow needs a proposal/decision record before implementation.

If an ingress issue names a target branch, inspect that branch and pass the same branch to downstream jobs.
