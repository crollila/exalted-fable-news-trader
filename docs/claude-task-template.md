# Claude Task Template — ExaltedFable

Use this template for routine Claude/Cowork tasks to avoid long repeated
prompts. STATUS.md carries the current state; CLAUDE.md carries the standing
rules — prompts do not need to restate either.

## Compact task prompt

```text
Continue ExaltedFable from STATUS.md.

First read:
- STATUS.md
- CLAUDE.md
- BUILD_PLAN.md
- PROJECT_CONTEXT.md
- relevant docs/source files for this task

Run:
- git status
- git log -1 --oneline
- npm test

If repo state differs from STATUS.md, stop and explain before editing.

Task:
[one clear task]

Limits:
- no model calls unless explicitly approved
- no provider API calls unless explicitly approved
- no trading logic
- no dependencies or package changes unless explicitly approved
- no .env edits or API keys
- do not stage, commit, or push

Expected changed files:
- [list expected files or categories]

If actual changed files differ from expected files, stop and explain before continuing.

Report:
- changed files
- what changed
- npm test result
- git diff --stat
- git status
- risks/limitations
- recommended commit message
```

## Rules

- STATUS.md is the current state source of truth.
- CLAUDE.md is the standing behavior/rules source of truth.
- Keep prompts short by referencing project docs instead of restating all
  prior history.
- Use longer prompts only for risky work, schema migrations, provider/model
  integration, or trading-adjacent changes.
- Do not stage, commit, or push unless the current prompt explicitly
  approves it.
