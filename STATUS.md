# STATUS.md — ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status
- Stable. All tests passing (132/132).
- Phase 1 (database foundation) and Phase 2 skeleton (provider abstraction) committed.
- Published to GitHub (public): https://github.com/crollila/exalted-fable-news-trader

## Latest Confirmed Commit
- Previous: `534fa41` — test(pipeline): add fixture-only end-to-end research loop proof
- This commit: docs(real-data): plan first real-data tier step
  (hash cannot self-reference — verify with `git log -1 --oneline`)

## Current Phase
Phase 2 functionally complete (contract, normalization, four adapter
skeletons, ingestion, persistence, registry tests, docs).
Phase 3 — Sentiment & Classification: fixture-only implementation started
(contract/parser/fixture classifier only; no model calls, no storage writer).

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
- Standing workflow/task rules added to CLAUDE.md (safest-state inference,
  expected-changed-files reporting, docs-only defaults for planning tasks,
  provider-sentiment isolation rules).
- Phase 3 sentiment/classification planning doc created
  (docs/sentiment-classification-plan.md): taxonomy v1, scoring output
  schema, prompt versioning, parser_status/fallback handling, storage
  mapping with gaps, future testing plan. README linked to the new doc.
- Phase 3 step 1 (src/sentiment/): fixture-only classifier contract;
  parser/validator for model response fixtures; fixture classifier with
  injected responder and no default model access; parser outcome tests
  covering valid output, malformed JSON, missing required fields, invalid
  score ranges, enum fallback handling, model_error, raw response
  preservation, required prompt_version, and classification failure not
  blocking ingestion and not writing to sentiment_scores (13 tests).
- Sentiment storage design (docs/sentiment-storage-plan.md, linked from
  README): gap analysis of sentiment_scores vs parser output; decision is
  hybrid — explicit columns for parser_status, impact_score, direction,
  time_horizon plus one JSON detail column for affected_symbols, rationale,
  errors; planned migration 002 and writer mapping documented as future
  work only.
- Sentiment storage implementation (migration
  002_sentiment_scores_phase3.sql + src/database/sentimentScores.js):
  additive columns with CHECK constraints per the storage plan;
  insertSentimentScore writer mapping ClassificationResult to rows with
  parse_ok derived from parser_status, NULL scores for failed parses
  (failures stored as data), byte-for-byte raw_response preservation, JSON
  detail column for affected_symbols/rationale/errors; read/aggregate
  helpers; 9 tests, fixture classifier/parser results only.
- Optional classification stage (src/ingestion/classifyNews.js):
  classifyAndStore for explicit event ids and ingestAndClassify for newly
  inserted events only; idempotent reruns via (event, model, prompt_version)
  existence check, no schema change; observable summaries with statusCounts
  and per-event errors; ingestNews behavior unchanged when no classifier is
  supplied; full local pipeline proven news -> normalized event ->
  news_events row -> fixture classifier -> sentiment_scores row; 10 tests.
- Phase 4 event-study design (docs/event-study-plan.md, linked from
  README): canonical horizons (10s/1m/5m/30m/1h/eod), windows anchored at
  received_at to avoid look-ahead bias, measurement_status for unavailable
  prices (failures are data), score linkage grouped by prompt_version,
  canonical-event rule for duplicates, decision to keep one row per
  (event, horizon); migration 003 rebuild and fixture PriceSource step
  documented as future work only.
- Compact Claude/Cowork task template (docs/claude-task-template.md,
  linked from README, referenced by a CLAUDE.md rule): routine prompts now
  reference STATUS.md/CLAUDE.md instead of restating project history;
  long prompts reserved for risky work.
- Phase 4 event-study storage foundation: migration
  003_price_reactions_event_study.sql rebuilds price_reactions with
  canonical horizons (10s/1m/5m/30m/1h/eod), measurement_status, nullable
  prices for unavailable data, anchor/source columns; PriceSource fixture
  contract (src/prices/priceSource.js, injected trades, throwing default);
  insertPriceReaction writer with replace-on-remeasure semantics and
  status/price consistency checks (src/database/priceReactions.js);
  10 tests, fixture-only.
- Event-study measurement engine (src/eventStudy/measureReactions.js):
  measureEvent anchors at news_events.received_at; baseline = last trade
  at or before anchor_at within the fixture lookback; reaction = last
  trade strictly after anchor and at or before the horizon target; rows
  written only through insertPriceReaction (idempotent replace);
  no_baseline/no_reaction/source_error stored as data; temporary fixture
  EOD policy = same UTC day 21:00:00.000Z (documented in the plan);
  market_closed policy still deferred; batch helper; 10 tests.
- End-to-end fixture pipeline proof (tests/pipeline.test.js): full local
  research loop proven — provider fixture -> news_events row -> fixture
  classifier -> sentiment_scores row -> fixture PriceSource ->
  price_reactions rows; research join proven across news_events x
  sentiment_scores x price_reactions grouped/filtered by prompt_version
  and parser/measurement status; idempotency proven at every stage (news
  dedup, classification skip for existing model + prompt_version,
  measurement replace-on-remeasure); zero network across the loop.
  The fixture tier is now complete as a local proof.
- Real-data tier plan (docs/real-data-tier-plan.md, linked from README):
  compares first real provider transport vs first real market-data client;
  recommends the Alpaca News transport first because it fits entirely
  behind the existing provider abstraction (prices-before-news would
  measure nothing); defines the API-key/.env safety plan, no-secret
  logging rules, fake-HTTP test strategy, and disabled-by-default rule.
  Implementation deferred until separately approved.

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
- src/sentiment is pure/local: no model, API, or network calls anywhere in
  the module. Provider-supplied sentiment remains in raw_payload only.
- The parser/classifier remains fixture-only. sentiment_scores rows are
  written ONLY via insertSentimentScore (directly or through the optional
  classifyAndStore/ingestAndClassify stage); no model calls anywhere. No
  trading logic. Classification is a separate optional stage that can never
  block or delete news_events rows.
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
- parser_status is nullable at the schema level (SQLite additive-column
  limitation); presence is enforced by the writer, so rows must not be
  inserted into sentiment_scores except through insertSentimentScore.
- EOD policy is a temporary fixture rule (same UTC day 21:00:00.000Z);
  real session calendars and the market_closed policy arrive with the
  real market-data client. No real market-data clients, no model calls,
  no trading logic.
- Ingestion is mock/local only until real provider adapters are added.
- Provider adapters (Alpaca, Benzinga, Alpha Vantage, Polygon/Massive)
  are fixture/transport-injection only; no real API clients yet.
- Alpha Vantage article IDs are derived (from URL) because the provider
  feed lacks a dedicated event ID.
- receivedAt is stamped at normalization time for now (true wire-receipt
  timestamps arrive with the real transport).

## Next Recommended Task
If the real-data plan is approved: implement
createAlpacaNewsHttpTransport(config) per docs/real-data-tier-plan.md §8
— one-shot fetch, injected HTTP layer, key from config only,
not-configured throw, fake-HTTP tests, key-redaction test, no polling,
no scheduling, no dependencies. Requires separate explicit approval
before any implementation begins.

## Maintenance Rule
After every approved commit, Claude should update STATUS.md with:
- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
