# STATUS.md — ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status
- Stable. All tests passing (200/200).
- Phase 1 (database foundation) and Phase 2 skeleton (provider abstraction) committed.
- Published to GitHub (public): https://github.com/crollila/exalted-fable-news-trader

## Latest Confirmed Commit
- Latest committed: `5c26e57` — feat(scripts): add manual scoring and MVP
  pipeline (scripts/classifyNewsOnce.js + scripts/runMvpPipelineOnce.js +
  tests/classifyNewsOnce.test.js + tests/runMvpPipelineOnce.test.js +
  package.json test enumeration + README manual-usage sections). 24 new
  network-free tests; 224/224 passing.
- Previous: `2b4b131` — docs(status): record Phase A manual MVP loop result
  (STATUS.md only).
- This STATUS update is committed separately as
  `docs(status): record Phase B MVP pipeline commit` (STATUS.md only).
  (verify committed head with `git log -1 --oneline`)

## Current Phase
Phase 2 functionally complete (contract, normalization, four adapter
skeletons, ingestion, persistence, registry tests, docs).
Phase 3 — Sentiment & Classification: fixture-only implementation started
(contract/parser/fixture classifier only; no model calls, no storage writer).
Phase B (manual MVP loop) — manual scoring + single end-to-end pipeline
command IMPLEMENTED and COMMITTED (`5c26e57`); default scoring is a
deterministic model-free baseline (no model calls). NOT YET RUN against the
live feed.

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
- Manual Alpaca Trades smoke-check script (scripts/smokeAlpacaTrades.js,
  documented in README), implementing step 3 of the market-data client plan
  §16: manual-only, never part of npm test or startup; CLI-guarded (import is
  side-effect free); credentials via config only (.env loaded with
  --env-file); explicitly constructs createAlpacaTradesPriceSource(config) —
  the only place a real market-data path is enabled — and fetches one tiny
  recent window for one ticker. The window ends --lag minutes in the past
  (default 20, floored at 16) to stay outside the free-feed too-recent
  restriction and spans --minutes (default 5, capped 60). Sanitized whitelist
  output only (symbol, window, source name, count, first/last timestamps,
  min/max price — all public market data; never keys, headers, request URLs,
  or raw payloads); zero trades is still a PASS (reachability/normalization,
  not feed completeness). No DB writes, no polling/scheduling, no
  trading/model calls. 9 network-free formatter/arg/window tests
  (tests/smokeTradesFormat.test.js).
- Manual Alpaca Trades smoke check RUN LOCALLY and PASSED (real .env
  credentials, command: node --env-file=.env scripts/smokeAlpacaTrades.js
  --symbol AAPL --minutes 5 --lag 20). Window
  2026-06-16T22:34:26.007Z → 2026-06-16T22:39:26.007Z via source
  "alpaca_iex"; trades 0; result PASSED (source reachable, trades
  normalized). Zero trades is acceptable/expected outside market hours or on
  the thin IEX feed — the check proves reachability and normalization, not
  feed completeness. Sanitized output only (symbol, window, source name,
  count) — no keys, auth headers, request URLs, or raw payloads. The trades
  client's reachability and PriceSource-compatible normalization are now
  confirmed against the live feed; a non-empty-window run during market hours
  is still worth doing later to exercise the price/timestamp mapping on real
  ticks.
- Manual capped measurement script (scripts/measureReactionsOnce.js,
  documented in README), implementing step 4 of the market-data client plan
  §16 / §15: manual-only, never part of npm test or startup; CLI-guarded
  (import is side-effect free); credentials via config only (.env loaded with
  --env-file). Selects a TINY capped set of EXISTING news_events rows
  (default 1, hard max 5 via --limit; or specific --ids, also capped at 5);
  only rows with both ticker and received_at are eligible. Explicitly
  constructs createAlpacaTradesPriceSource(config) — the only place a real
  market-data path is enabled — and runs the EXISTING measureEvents batch
  helper, so all rows are written ONLY through insertPriceReaction
  (idempotent replace-on-remeasure; no new write path, no engine change).
  Sanitized summary output only (selected/measured/failed event counts,
  measurement_status counts, horizons attempted, source name, and a compact
  per-event id/ticker/per-horizon-status line) — never keys, headers, request
  URLs, raw trade payloads, or raw news payloads. no_baseline/no_reaction on
  out-of-hours events is the expected, correct failures-as-data outcome. No
  sentiment/model calls, no trading, no paper orders. 12 network-free tests
  (tests/measureReactionsOnce.test.js) using an in-memory DB and a fixture
  PriceSource — arg parsing/cap enforcement, selection ordering/cap,
  no-event behavior, status aggregation, summary formatting, output
  redaction, and the real writer path offline. NOT YET RUN against the live
  feed.
- Manual research summary script (scripts/reportEventStudySummary.js,
  documented in README): manual-only, READ-ONLY (SELECTs only — no writes, no
  migrations, no network, no credentials needed); CLI-guarded. Opens the
  configured SQLite file (errors clearly if the file or event-study tables are
  absent) and prints a sanitized, paste-safe snapshot: total news_events,
  sentiment_scores, and price_reactions rows; measurement_status counts;
  horizon counts; measured-return averages by horizon; and a small capped list
  (--limit, default 10, max 50) of recent measured rows (event id, ticker,
  horizon, return, timestamp). Output is a strict whitelist of ids, tickers,
  horizons, statuses, timestamps, and numeric returns — never headlines,
  bodies, raw_payload, raw model responses, keys, or any free-text content. 8
  network-free tests (tests/reportEventStudySummary.test.js) using an
  in-memory DB — arg parsing/cap, aggregation, empty-database behavior,
  recent-rows cap, formatting, and redaction/paste-safety.
- Phase A manual MVP loop RUN LOCALLY end-to-end (real .env credentials).
  Measurement (node --env-file=.env scripts/measureReactionsOnce.js --limit 1):
  source alpaca_iex; selected 1 event, measured 1, failed 0; horizons
  10s/1m/5m/30m/1h/eod; statuses no_baseline=6; 6 rows written, 0 replaced;
  event 1 AAPL returned no_baseline for all six horizons; measurement
  COMPLETE — rows written through insertPriceReaction. Report
  (node --env-file=.env scripts/reportEventStudySummary.js --limit 10):
  news_events 5, sentiment_scores 0, price_reactions 6; measurement_status
  no_baseline=6; horizon counts 10s=1/1m=1/5m=1/30m=1/1h=1/eod=1; no measured
  rows yet (no measured-return averages, no recent measured rows). This proves
  the manual MVP loop at the database level: existing news_events -> real
  Alpaca Trades PriceSource path -> measureReactions -> price_reactions rows ->
  read-only research report. The all-no_baseline outcome is the expected,
  correct failures-as-data result (the selected event/window had no usable
  baseline trade, likely outside market hours). This proves write/read
  pipeline behavior, NOT profitable signal or real measured returns yet. git
  status clean after the run; the database file and .env remained
  ignored/untracked. No sentiment/model calls, no trading, no paper orders.
- Manual scoring/classification script (scripts/classifyNewsOnce.js,
  documented in README): manual-only, CLI-guarded (import is side-effect
  free); needs NO credentials and NO network. Scores a TINY capped set of
  EXISTING news_events rows (default 1, hard max 5 via --limit; or specific
  --ids, also capped at 5) using a DETERMINISTIC model-free baseline
  classifier built by wrapping the existing createFixtureClassifier with a
  local responder (manualBaselineResponse). The baseline is intentionally
  NEUTRAL — sentiment/impact/confidence = 0, direction = "unclear",
  model = "manual_baseline", prompt_version = "manual_v1" — so it never
  fabricates edge; it exists to prove the loop carries a score, it is a
  PLACEHOLDER not trading signal. Writes ONLY through the existing
  classifyAndStore -> insertSentimentScore path (no schema change, no
  parser/storage semantics change); reruns are idempotent by
  (event, model, prompt_version). Without --ids, selects only rows not yet
  scored by this (model, prompt_version). Sanitized summary output only
  (selected/classified/stored/skipped/failed counts, parser_status counts,
  model, prompt_version) — never raw news payloads, raw model responses,
  keys, or headers. 15 network-free tests (tests/classifyNewsOnce.test.js)
  using an in-memory DB — arg parsing/cap, deterministic-responder
  properties, unscored selection + already-scored exclusion, explicit-ids
  selection, no-event behavior, summary formatting, redaction, and the real
  writer path offline. NOT YET RUN against real ingested events.
- Single capped manual end-to-end MVP pipeline script
  (scripts/runMvpPipelineOnce.js, documented in README): manual-only,
  CLI-guarded; RESEARCH/MEASUREMENT ONLY — it never trades, submits orders, or
  calls any trading API. Runs four clearly-reported stages through the EXISTING
  paths only: (1) optional Alpaca news ingest via the existing transport ->
  ingestNews -> news_events (default 5, hard max 20; skipped via --skip-ingest
  or when credentials are absent); (2) deterministic manual scoring of a tiny
  unscored set -> sentiment_scores (default 1, max 5); (3) capped measurement
  via createAlpacaTradesPriceSource + measureEvents -> price_reactions
  (default 1, max 5; skipped when credentials are absent); (4) read-only
  research summary via reportEventStudySummary's collectSummary. The
  orchestrator runPipeline takes INJECTED dependencies (provider/classifier/
  priceSource), so tests drive the whole sequence offline; buildPipelineReport
  COMPOSES the existing ingest/classify/measure/summary report builders rather
  than duplicating report logic. Stages 1 and 3 are reported as SKIPPED (with
  reason) when uncredentialed; no_baseline/no_reaction outcomes are reported as
  data, never hidden. Sanitized output only — never keys, headers, request
  URLs, raw trade payloads, raw news payloads, or raw model responses. 9
  network-free tests (tests/runMvpPipelineOnce.test.js) using an in-memory DB,
  a mock provider, the manual classifier, and a fixture PriceSource — arg
  parsing/cap enforcement, full offline sequence with a zero-network assertion,
  skip behavior, no_baseline-as-data, report composition, SKIPPED markers, and
  import safety. NOT YET RUN against the live feed.

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
  existing pipeline). Both are proven against the live feed.
- The real Alpaca Trades PriceSource has one manual entry point so far: the
  trades smoke check (scripts/smokeAlpacaTrades.js, no DB writes), which
  explicitly constructs createAlpacaTradesPriceSource(config). It has been
  run once against the live feed (2026-06-16, PASSED, zero-trade window).
  There is still NO automatic live data path anywhere — real
  transports/clients activate only by explicit construction in these
  manually-run scripts.
- src/sentiment is pure/local: no model, API, or network calls anywhere in
  the module. Provider-supplied sentiment remains in raw_payload only.
- The parser/classifier remains model-free. sentiment_scores rows are
  written ONLY via insertSentimentScore (directly or through the optional
  classifyAndStore/ingestAndClassify stage); no model calls anywhere. No
  trading logic. Classification is a separate optional stage that can never
  block or delete news_events rows. The new manual scorer
  (scripts/classifyNewsOnce.js) is just createFixtureClassifier wrapped with a
  deterministic local responder — it is a neutral PLACEHOLDER baseline
  (model="manual_baseline", prompt_version="manual_v1"), not signal, and still
  needs no model/keys/network.
- The whole manual research loop now also has a single end-to-end entry point
  (scripts/runMvpPipelineOnce.js): optional ingest -> manual scoring -> capped
  measurement -> read-only summary, composed entirely from existing paths and
  report builders. It is RESEARCH-ONLY (no trading/order calls), CLI-guarded,
  and reports SKIPPED stages plus no_baseline/no_reaction outcomes as data.
- Tests: Node built-in test runner (`npm test`), 224/224 passing.
- No automatic/scheduled provider or market-data calls. Live touchpoints are
  manual scripts only: news smoke check, news one-shot ingest, trades smoke
  check (each run against the live feed at least once), plus the capped
  measurement and the end-to-end pipeline (whose ingest/measure stages reuse
  those same transports). No sentiment/model calls, no execution/trading calls
  anywhere.

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
- The trades client smoke check has been run once against the live feed
  (2026-06-16, PASSED) but only over a ZERO-TRADE window (run outside market
  hours), so the price/timestamp mapping has not yet been exercised on real
  ticks; a non-empty-window run during market hours is still worth doing.
  The capped manual MEASUREMENT script has now been run once (Phase A MVP
  loop), but it produced all-no_baseline rows (no usable baseline trade,
  likely outside market hours), so the price/timestamp/return mapping has
  STILL not been exercised on real measured ticks. A market-hours rerun that
  yields measured rows with actual returns remains an open low-priority
  follow-up.
- The default scorer is a NEUTRAL placeholder (all-zero sentiment/impact/
  confidence, direction "unclear"). It proves the loop carries a score, but
  carries NO predictive content — nothing downstream should treat
  manual_baseline scores as signal. A real model classifier (its own
  separately-approved phase) is required before any edge claim.
- The pipeline's ingest hard cap is 20 (vs. 10 for the standalone one-shot
  ingest script); the Alpaca News transport is still single-page only, so even
  at 20 a run fetches one page and does no pagination/backfill.
- Phase B (manual scoring + end-to-end pipeline) is committed and fully tested
  offline but NOT YET RUN against the live feed; the manual_baseline path has
  not yet scored real ingested events, and the pipeline has not yet been
  exercised end-to-end with real credentials.

## Next Recommended Task
Phase B (manual scoring + single end-to-end MVP pipeline command) is now
IMPLEMENTED and COMMITTED as `5c26e57` (scripts/classifyNewsOnce.js +
scripts/runMvpPipelineOnce.js, 24 network-free tests, 224/224 passing), but
NOT YET RUN against the live feed.

Recommended next step: RUN the new manual loop once locally during/after US
market hours and record the result in STATUS, as the prior smoke/ingest/
measurement runs were recorded:
  node --env-file=.env scripts/classifyNewsOnce.js --limit 1
  node --env-file=.env scripts/runMvpPipelineOnce.js --symbols AAPL \
    --ingest-limit 5 --classify-limit 1 --measure-limit 1
Expect the manual_baseline scorer to write parsed (all-zero) sentiment_scores
rows, and expect several horizons to land on no_baseline/no_reaction for
events received outside market hours — both are correct, not bugs.

Then (the real edge work, its own separately-approved phase): replace the
neutral manual_baseline scorer with a REAL model-backed classifier behind the
same classifier contract (explicit, manual-only, key-via-config, sanitized
output, no live calls in npm test) so scores carry actual content. Only after
real scores + market-hours measured returns exist can any edge be measured.

Optional, low priority: re-run the capped measurement on MARKET-HOURS events
(node --env-file=.env scripts/measureReactionsOnce.js --limit 1) to get
measured rows with actual returns, and re-run the trades smoke check during
market hours to confirm the price/timestamp mapping on a non-empty window.

Then (later, semantics-changing, bigger review): step 5 of
docs/market-data-client-plan.md — real session-calendar / market_closed /
true-EOD policy — remains deferred to its own task.

## Maintenance Rule
After every approved commit, Claude should update STATUS.md with:
- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
