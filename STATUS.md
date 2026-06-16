# STATUS.md — ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status
- Stable. All tests passing (171/171).
- Phase 1 (database foundation) and Phase 2 skeleton (provider abstraction) committed.
- Published to GitHub (public): https://github.com/crollila/exalted-fable-news-trader

## Latest Confirmed Commit
- Latest committed: `d3b1984` — feat(prices): add Alpaca trades PriceSource
  (first real Alpaca trades PriceSource: src/prices/alpacaTradesPriceSource.js
  + tests + package.json enumeration). Committed locally, not yet pushed.
- Previous: `7b67f7a` — docs(prices): add market-data client plan for first real PriceSource
  (verify committed head with `git log -1 --oneline`)

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
- First real-data tier implementation: Alpaca News HTTP transport
  (src/providers/alpacaNewsHttpTransport.js), explicit one-shot transport
  behind the existing fetchRawNews injection point. The Alpaca provider
  remains transport-injection based and disabled by default; credentials
  read only through config.alpacaNews (no process.env reads outside
  config); fake-HTTP tests only, no live-network tests in npm test;
  sanitized/key-redacted errors tested; no polling, scheduling,
  dependencies, model calls, market-data client, schema changes, or
  trading logic. 9 tests.
- Manual Alpaca News smoke-check script (scripts/smokeAlpacaNews.js,
  documented in README): manual-only, never part of npm test or startup;
  credentials via config only (.env loaded with node --env-file);
  sanitized whitelist output only (count, headline, ticker/symbols,
  published timestamp, event id, public article URL — never keys,
  headers, request URLs, or raw payloads); tiny capped sample; no
  database writes, no polling/scheduling, no trading/model/market-data
  calls; 7 network-free formatter tests.
- Manual Alpaca News smoke check RUN LOCALLY and PASSED (real .env
  credentials, command: node --env-file=.env scripts/smokeAlpacaNews.js
  --symbols AAPL --limit 5): fetched 5 event(s) via provider "alpaca",
  transport reachable, payload normalized. Sanitized output only
  (timestamps, symbols, headlines, provider ids, public URLs) — no keys,
  auth headers, .env values, or raw payloads printed. git status clean
  after the run; .env remained ignored/untracked. No database writes,
  model calls, market-data calls, polling, scheduling, trading, or paper
  orders occurred. The transport's field mapping is confirmed against the
  live v1beta1 feed; no mapping adjustment needed.
- Manual one-shot live ingest script (scripts/ingestAlpacaNewsOnce.js,
  documented in README): manual-only, never part of npm test or startup;
  explicitly constructs createAlpacaNewsHttpTransport(config) and the
  existing Alpaca provider, then persists through the EXISTING
  ingestNews -> insertNewsEvent path into news_events (no separate
  persistence path; provider-scoped dedup applies); uses existing
  openDatabase/runMigrations utilities against config.databasePath;
  credentials via config only; limit hard-capped at 10 via the shared
  parseArgs; sanitized summary output only (provider, counts, inserted
  ids, db path, truncated per-event errors — never keys, headers, request
  objects, raw transport errors, or raw payloads); import-safe CLI guard;
  no polling/scheduling/background jobs, no sentiment/classification, no
  sentiment_scores or price_reactions writes, no trading/paper orders;
  7 network-free formatter/cap tests (tests/ingestScriptFormat.test.js).
- Manual one-shot live ingest RUN LOCALLY and PASSED with dedup proof
  (real .env credentials, command: node --env-file=.env
  scripts/ingestAlpacaNewsOnce.js --symbols AAPL --limit 5).
  First run: fetched 5, inserted 5, duplicates 0, failed 0, inserted ids
  1–5; database path shown as data/exalted_fable.sqlite under the project
  folder. Second identical run: fetched 5, inserted 0, duplicates 5,
  failed 0, no inserted ids. Real events persisted through the existing
  provider -> ingestNews -> insertNewsEvent path, and (provider,
  provider_event_id) dedup is proven against live data on the repeat run.
  git status clean after both runs; the database file and .env remained
  ignored/untracked. No model calls, sentiment/classification writes,
  market-data calls, price_reactions writes, polling, scheduling, trading,
  or paper orders occurred. The local research database now contains its
  first real news_events rows.
- Market-data client plan (docs/market-data-client-plan.md, linked from
  README): design doc only for the first real PriceSource. Recommends
  Alpaca historical trades (IEX free feed) because the existing key pair
  works, it returns actual trades (the contract's unit), and the
  sanitization pattern is already proven; documents the frozen
  getTradesAround contract plus the engine's lexicographic-ISO timestamp
  assumption, the trades-endpoint field mapping with ns→ms normalization,
  bounded pagination with throw-on-cap (truncated windows must never
  masquerade as measured), the client-throws/engine-stores-status split
  preserving all measurement_status semantics, market_closed and real EOD
  explicitly deferred to a later session-calendar task, look-ahead
  guarantees (anchor stays received_at; window never widened), no-secret
  logging rules, free-tier/rate-limit notes (no retries in v1; 429 is a
  visible source_error), fake-HTTP test plan, and future manual
  smoke-check and capped manual measurement scripts. Implementation,
  scripts, and tests all deferred to separately approved tasks.
- First real market-data client (src/prices/alpacaTradesPriceSource.js):
  createAlpacaTradesPriceSource(config, options) behind the existing
  PriceSource contract, implementing step 2 of the market-data client plan.
  Explicit construction only (no import-time/startup network path); throws
  "not configured" without keys; credentials read only from config.alpacaNews
  (the shared ALPACA_API_KEY_ID/SECRET pair — see naming debt below) and sent
  in headers only, never logged/returned/thrown. Injectable httpFetch (defaults
  to globalThis.fetch) keeps npm test fully offline; default feed 'iex'.
  Validates ticker/fromIso/toIso; requests only the requested UTC window with
  whole-second floor(start)/ceil(end) bounds, then post-filters trades to the
  exact ms-precision [fromIso, toIso] window (look-ahead guarantee preserved).
  Maps t/p/s -> {at, price, size} with ns->ms-normalized UTC ISO; returns
  trades sorted ascending; [] for empty windows. Bounded pagination
  (next_page_token) with a hard page cap that THROWS rather than silently
  truncating. Sanitized/redacted errors for HTTP 401/403/429/5xx, malformed
  payloads, and all-malformed trade items. All measurement_status semantics
  stay in measureReactions (client returns trades or throws). 16 fake-HTTP
  tests, no credentials, no live network, no DB writes.

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
  ingestion tests, and the same unchanged path has now carried real
  Alpaca events in manual runs. No sentiment/model calls, no trading logic.
- All planned provider adapters (Alpaca, Benzinga, Alpha Vantage,
  Polygon/Massive) map provider-shaped raw items into canonical normalized
  events. Adapters are non-network until real transports/clients are
  explicitly added later. No API keys anywhere, no sentiment/model calls,
  no writes to sentiment_scores, no trading logic.
- Provider exports are covered by registry tests; contract drift or a
  missing export is caught by the test suite.
- The real Alpaca News transport now has two manual entry points: the
  smoke check (scripts/smokeAlpacaNews.js, no DB writes) and the one-shot
  ingest (scripts/ingestAlpacaNewsOnce.js, writes news_events only via the
  existing pipeline). Both are proven against the live feed. There is
  still NO automatic live data path anywhere — real transports activate
  only by explicit construction in these manually-run scripts.
- src/sentiment is pure/local: no model, API, or network calls anywhere in
  the module. Provider-supplied sentiment remains in raw_payload only.
- The parser/classifier remains fixture-only. sentiment_scores rows are
  written ONLY via insertSentimentScore (directly or through the optional
  classifyAndStore/ingestAndClassify stage); no model calls anywhere. No
  trading logic. Classification is a separate optional stage that can never
  block or delete news_events rows.
- Tests: Node built-in test runner (`npm test`).
- No automatic/scheduled provider calls; the only live touchpoints are
  the two manual scripts. No sentiment/model calls, no market-data calls,
  no execution/trading calls yet.

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
- Alpaca News transport is single-page only; pagination/backfill is
  deferred and must precede any bulk historical fetch.
- The smoke check proves reachability/shape compatibility only, not feed
  completeness; it has passed once locally (2026-06-10) but each run
  depends on local .env credentials.
- Real-event ingestion exists only as the manual one-shot script; rows it
  inserts carry receivedAt stamped at normalization time, which for live
  manual runs is fetch time (close to, but not exactly, wire receipt).
- The configured SQLite file (data/exalted_fable.sqlite by default) is
  git-ignored and must never be committed; it now contains a first small
  sample of real AAPL news_events rows, and manual ingest runs grow it.
- The live sample is tiny (5 events, one symbol); nothing downstream
  should draw research conclusions from it yet.
- Provider adapters (Alpaca, Benzinga, Alpha Vantage, Polygon/Massive)
  are fixture/transport-injection only; no real API clients yet.
- Alpha Vantage article IDs are derived (from URL) because the provider
  feed lacks a dedicated event ID.
- receivedAt is stamped at normalization time for now (true wire-receipt
  timestamps arrive with the real transport).
- The planned market-data client will use the free IEX feed (subset of
  consolidated tape); thin coverage shows up as no_baseline/no_reaction
  rows — visible bias, not silent absence (docs/market-data-client-plan.md
  §4/§12). Exact Alpaca rate limits/entitlements must be re-verified at
  implementation time.
- NAMING DEBT: the Alpaca trades PriceSource reads credentials from
  config.alpacaNews, the same ALPACA_API_KEY_ID/SECRET pair the news
  transport uses. The keys are account-level (not news-specific), so this is
  correct functionally but the config key name "alpacaNews" is now misleading
  for a market-data client. Consider renaming the config key to a shared
  `alpaca` credentials path in a later reviewed task and updating both
  consumers together.
- The Alpaca trades client is single-window with a hard page cap that throws
  (DEFAULT_MAX_PAGES = 10); very large windows are refused rather than
  truncated. Higher-throughput backfill (raising the cap or windowing) is
  deferred. No retries on 429/5xx in v1 — a rate-limited or failed request
  surfaces as a sanitized source error (the engine stores source_error).
- No manual smoke-check or capped measurement script exists yet for the
  trades client; the implementation has only been exercised by fake-HTTP
  tests (no live market-data call has been made).

## Next Recommended Task
Step 2 of docs/market-data-client-plan.md §16 (the real Alpaca trades
PriceSource) is implemented as src/prices/alpacaTradesPriceSource.js
(fake-HTTP tests only) and committed as `d3b1984` (not yet pushed).

Next (separately approved, §16 items 3–4): a manual smoke-check script for
the trades client (manual-only, never in npm test or startup; credentials
via config only; sanitized whitelist output; tiny capped sample; no DB
writes, no polling/scheduling, no trading/model calls), followed by a capped
manual measurement script that drives measureReactions against the real
client. Both must stay off the npm test path. Real session-calendar /
market_closed / true-EOD policy remain deferred to their own task.

## Maintenance Rule
After every approved commit, Claude should update STATUS.md with:
- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
