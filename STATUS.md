# STATUS.md — ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status
- Stable. All tests passing (78/78).
- Phase 1 (database foundation) and Phase 2 skeleton (provider abstraction) committed.
- Published to GitHub (public): https://github.com/crollila/exalted-fable-news-trader

## Latest Confirmed Commit
- Previous: `0af9a9c` — test(providers): add registry tests for exports, names, and contracts
- This commit: docs(providers): document adapter pattern and Phase 2 readiness
  (hash cannot self-reference — verify with `git log -1 --oneline`)

## Current Phase
Phase 2 — News Provider Abstraction. The Phase 2 skeleton is functionally
complete (contract, normalization, four adapter skeletons, ingestion,
persistence, registry tests, docs) pending ChatGPT/user decision to move on.

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
- Benzinga News adapter skeleton (src/providers/benzingaNewsProvider.js):
  same injected-transport pattern, no default network calls; static Benzinga
  fixture tests including RFC-2822 timestamp normalization; fixture-backed
  ingestion integration proving insert/dedup/query; provider-scoped dedup
  verified across Alpaca and Benzinga shared numeric IDs.
- Alpha Vantage News Sentiment adapter skeleton
  (src/providers/alphaVantageNewsProvider.js): injected transport only, no
  default network calls; static fixture tests; deterministic providerEventId
  derived from article URL (fallback for URL-less items); compact UTC
  timestamp parsing; ticker_sentiment mapped to canonical symbols; provider
  sentiment fields retained only in raw_payload; fixture-backed ingestion
  integration proving insert/dedup/query; cross-provider shared-ID dedup
  remains scoped by provider name.
- Polygon/Massive News adapter skeleton (src/providers/polygonNewsProvider.js):
  injected transport only, no default network calls; static Polygon fixture
  tests; providerEventId mapped directly from Polygon hash ID; published_utc
  ISO timestamp validation; tickers mapped to canonical symbols; publisher
  and insights/sentiment fields retained only in raw_payload; fixture-backed
  ingestion integration proving insert/dedup/query; cross-provider shared-ID
  dedup remains scoped by provider name.
- All four planned provider adapter skeletons are now complete:
  Alpaca, Benzinga, Alpha Vantage, Polygon/Massive.
- Provider registry hardening (tests/providerRegistry.test.js + shared
  registry helper in tests/helpers/providerTestHelpers.js): verifies all
  four planned provider factories are exported, provider names are stable
  and unique, all adapters pass contract validation, fixture transports
  yield normalized events, and no-transport defaults reject without
  network access.
- Provider adapter documentation (docs/providers.md, linked from README):
  abstraction purpose, canonical event path, injected-transport pattern,
  fixture-only safety, provider table, limitations, how to add a provider.
  Phase 2 readiness checkpoint recorded.

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
- All planned provider adapters (Alpaca, Benzinga, Alpha Vantage,
  Polygon/Massive) map provider-shaped raw items into canonical normalized
  events. Adapters are non-network until real transports/clients are
  explicitly added later. No API keys anywhere, no sentiment/model calls,
  no writes to sentiment_scores, no trading logic.
- Provider exports are covered by registry tests; contract drift or a
  missing export is caught by the test suite.
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
- Provider adapters (Alpaca, Benzinga, Alpha Vantage, Polygon/Massive)
  are fixture/transport-injection only; no real API clients yet.
- Alpha Vantage article IDs are derived (from URL) because the provider
  feed lacks a dedicated event ID.
- receivedAt is stamped at normalization time for now (true wire-receipt
  timestamps arrive with the real transport).

## Next Recommended Task
Planning prompt for Phase 3 sentiment/classification design (prompt
versioning, news type taxonomy, model response storage, malformed-output
fallback). Planning only — no immediate coding, no real API clients.

## Maintenance Rule
After every approved commit, Claude should update STATUS.md with:
- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
