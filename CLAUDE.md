# CLAUDE.md — ExaltedFable

You are helping build ExaltedFable, an AI news event-study and Alpaca paper-trading research system.

## Hard rules

- Do not enable live trading.
- Do not write code that can trade live unless explicitly requested later.
- `LIVE_TRADING_ENABLED=false` must remain the default.
- Never read, print, commit, or expose API keys.
- Never modify `.env` directly.
- Use `.env.example` for required environment variables.
- Do not overwrite the old V1 repo.
- Work only inside this V2 project unless explicitly told otherwise.
- Prefer small, reviewable changes.
- Explain every changed file.
- Add tests or validation scripts for important logic.
- Do not make broad rewrites without approval.

## Project goal

Turn the original prototype into a measurable research and paper-trading system that can prove whether AI-scored news events have trading edge.

## Required architecture

Use modular components:

- news providers
- database layer
- sentiment/classification engine
- event-study engine
- paper-trading execution
- risk engine
- reporting engine

## News providers

The system should support pluggable news providers:

- Alpaca News
- Benzinga
- Polygon/Massive
- Alpha Vantage
- future providers

Do not hard-code the system around one source.

## Data to store

Store:

- raw news event
- provider
- provider event ID
- ticker
- headline
- body/summary
- published timestamp
- received timestamp
- duplicate group
- news type
- sentiment score
- model response
- confidence
- theoretical entry price
- actual paper fill
- slippage
- exit price
- P&L
- max adverse excursion
- max favorable excursion
- exit reason
- trade reason

## Trading/risk rules

- Paper trading only.
- Add max position size.
- Add max daily loss.
- Add max trades per day.
- Add total exposure limit.
- Add kill switch.
- Log every rejected trade and why it was rejected.

## Development workflow

Before coding:
1. Inspect relevant files.
2. Summarize current state.
3. Propose a small change.
4. Wait for approval if the change is large.

After coding:
1. List changed files.
2. Explain what changed.
3. Explain how to test.
4. Explain risks/limitations.

## Commit, Status, and GitHub Push Workflow

Default behavior after coding: report changes and wait for ChatGPT/user review before committing or pushing, unless explicitly told to commit/push in the current prompt.

After every approved code/documentation change:

1. Run safety checks before committing:

   * `npm test`
   * `git status`
   * confirm no `.env` file is staged
   * confirm no API keys, secrets, tokens, database files, logs, `node_modules/`, or SQLite sidecar files are staged

2. Commit only after tests pass and the user/ChatGPT approves.

3. Update `STATUS.md` after each approved commit with:

   * latest commit hash
   * latest commit message
   * current phase
   * completed work
   * current architecture notes
   * known warnings or technical debt
   * next recommended task

4. Push to GitHub only after:

   * tests pass
   * working tree is clean except intended changes
   * `STATUS.md` is current
   * user/ChatGPT approves the push

5. Never push:

   * `.env`
   * API keys or tokens
   * generated database files
   * logs
   * `node_modules/`
   * SQLite `-wal`, `-shm`, or `-journal` files

GitHub repo target:

* `https://github.com/crollila/exalted-fable-news-trader`

Do not touch, rename, overwrite, or push to the old V1 repository.

## Standing task rules

For every task, infer and preserve the safest project state from `STATUS.md`, `BUILD_PLAN.md`, `PROJECT_CONTEXT.md`, and relevant docs before editing.

For documentation, planning, checkpoint, or phase-transition tasks:

* Treat `STATUS.md` as an expected changed file when the task changes current phase, completed work, architecture notes, warnings/technical debt, or next recommended task.
* Do not modify source behavior.
* Do not add database migrations.
* Do not add dependencies.
* Do not add API/model/provider calls.
* Do not add trading logic.
* Keep the change documentation-only unless the prompt explicitly approves code changes.

For provider-related or sentiment/classification-related tasks:

* Read `docs/providers.md` first if it exists.
* Provider-supplied sentiment must remain provider metadata in `raw_payload` until Phase 3 explicitly implements ExaltedFable's own sentiment/classification engine.
* Do not write provider-supplied sentiment into `sentiment_scores` unless a later reviewed task explicitly approves that behavior.

For all tasks:

* Report the intended changed files before commit.
* If the actual changed files differ from the expected files, stop and explain before staging.
