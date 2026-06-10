# STATUS.md — ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status
- Stable. All tests passing (45/45).
- Phase 1 (database foundation) and Phase 2 skeleton (provider abstraction) committed.
- Published to GitHub (public): https://github.com/crollila/exalted-fable-news-trader

## Latest Confirmed Commit
- Previous: `1b26eb6` — feat(ingestion): add provider-to-database ingestion pipeline
- This commit: feat(providers): add Alpaca News adapter skeleton with fixture tests
  (hash cannot self-reference — verify with `git log -1 --oneline`)

## Current Phase
Phase 2 — News Provider Abstraction (skeleton done; real adapters not started).

## Completed Work
- Initial setup (repo, docs, .gitignore, .env.example).
- Phase 1: config module with paper/live safety parsing, SQLite layer,
  versioned migrations, initial 6-table schema, 11 validation tests.
- Phase 2 skeleton: provider contract (JSDoc + runtime validators),
  canonical news event normalization, mock provider, 12 provider tests.
- News-event persistence helpers (src/database/newsEvents.js): insert with
  provider + provider_event_id dedup, find/list/count queries, 8 tests.
- Mock provider-to-database ingestion flow (src/ingestion/ingestNews.js):
  summary counts for fetched/inserted/duplicates/failed, per-event error
  capture without aborting the batch, 7 tests.
- Alpaca News adapter skeleton (src/providers/alpacaNewsProvider.js):
  injected transport only, no default network calls; static Alpaca fixture
  tests; fixture-backed ingestion integration proving insert/dedup/query.

## Current Architecture
- Node.js ESM, zero runtime dependencies (Node >= 22.5 required).
- SQLite via Node built-in `node:sqlite`; `src/database/db.js` is the only
  file touching the driver (swap point for better-sqlite3/Postgres later).
- Versioned SQL migrations in `src/database/migrations/`, runner is idempotent.
- Timestamps: UTC ISO-8601 text everywhere.
- Providers are pluggable; canonical event shape defined in
  `src/providers/newsProvider.js`, built by `src/providers/normalize.js`.
- Normalized provider events can now be persisted and queried
  (`src/database/newsEvents.js`); duplicates return the existing row id.
- Ingestion (`src/ingestion/ingestNews.js`) connects the provider
  abstraction to persistence; the mock provider supports end-to-end local
  ingestion tests. Still no real provider API calls, no sentiment/model
  calls, no trading logic.
- Provider adapters can map real-provider-shaped raw items into canonical
  normalized events. The Alpaca adapter is non-network until a real
  transport/client is explicitly added later. No API keys anywhere.
- Tests: Node built-in test runner (`npm test`).
- No real provider API calls, no sentiment/model calls, no execution/trading calls yet.

## Hard Safety Rules
- Do not overwrite or depend on the V1 repo.
- Paper trading only. Live trading disabled by default and unusable;
  enabling requires LIVE_TRADING_ENABLED=true AND
  CONFIRM_LIVE_TRADING_I_UNDERSTAND_RISK=true, and no code consumes it.
- Never commit API keys, secrets, .env, database files, or logs.
- Measurement before strategy optimization.
- Keep providers pluggable; no hard-coding around one source.

## Known Warnings / Technical Debt
- `node:sqlite` emits ExperimentalWarning on Node 22 (stable on Node 23.4+).
- `start` script points to src/index.js, which does not exist yet.
- newsType is always "other" until Phase 3 classification.
- url/author/symbols/summary have no dedicated columns yet; they live in
  news_events.raw_payload (JSON) until they earn columns.
- dedup_group remains null until cross-provider story grouping is built.
- Ingestion is mock/local only until real provider adapters are added.
- Alpaca adapter is fixture/transport-injection only; no real API client yet.
- receivedAt is stamped at normalization time for now (true wire-receipt
  timestamps arrive with the real transport).

## Next Recommended Task
Benzinga adapter skeleton with fixture tests, same pattern as the Alpaca
skeleton: injected transport, no real API calls, no keys.

## Maintenance Rule
After every approved commit, Claude should update STATUS.md with:
- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
