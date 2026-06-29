# STATUS.md — ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status
- Current working tree is an UNCOMMITTED PAPER-only implementation slice on top
  of `e2ee6d6` (`fix(paper): run fresh news decision cycle in paper loop`).
  It is not staged, committed, or pushed.
- Implemented in the working tree: OpenAI classifier provider via central
  `OPENAI_API_KEY`/`OPENAI_MODEL`; `real_model` is a visible deprecated alias
  for OpenAI; Anthropic is explicit-only; continuous market-aware PAPER loop
  with Alpaca clock/calendar checks; closed-market sleep without news/model/
  price/options/order calls; persistent runtime sessions; idempotent EOD
  Discord reports; advisory-only recommendation audits; controlled candidate
  universe selection; PAPER capability gates for shorts/options/margin; Alpaca
  read-only clock/calendar/asset/option-contract/option-quote helpers; and
  migration 004 for runtime/research audit records.
- Option scope in this working tree is deliberately limited to long call/put
  contract discovery and quote validation for PAPER research. PAPER option order
  submission is disabled until tested exit monitoring and sell-to-close
  reporting are implemented.
- Verification in this uncommitted tree: report-focused tests, affected focused
  suites, and full `npm test` pass. Latest full suite result: 499/499 passing
  with no network calls in tests.
- Phase 1 (database foundation) and Phase 2 skeleton (provider abstraction) committed.
- Published to GitHub (public): https://github.com/crollila/exalted-fable-news-trader
- Phase 5 (PAPER trading) FIRST VERTICAL SLICE is COMMITTED (`df1931f`): a
  manual one-shot paper-trade path (scripts/runPaperTradingOnce.js + src/paper/*
  + config + tests + docs). PAPER-only, dry-run by default, live trading still
  impossible/disabled.
- Phase 5 Discord verification + end-of-day report slice is COMMITTED
  (`0bb590c`): src/notifications/discordWebhookClient.js +
  scripts/smokeDiscordWebhook.js + scripts/sendPaperEodReport.js + config.discord
  + .env.example placeholders + 3 test files. PAPER-only, read-only EOD summary;
  Discord posts only when explicitly requested; the webhook URL is never printed.
  24 new network-free tests. OPENAI_MODEL wiring was DEFERRED (see warning below).
- Phase 5 ADVANCED PAPER trading is COMMITTED (`b3387d5`): equities long/short,
  single-leg long OPTIONS (explicit OCC --option-symbol; no contract discovery),
  margin-aware risk, and a market-hours PAPER loop. New:
  src/paper/accountCapabilities.js, src/paper/paperRisk.js,
  src/paper/optionsProposal.js, src/paper/marketHours.js,
  src/paper/paperTradingLoop.js, scripts/runPaperTradingLoop.js; extended
  src/paper/alpacaPaperClient.js (account/positions/option orders) +
  src/paper/paperTradeProposal.js (shorts) + scripts/runPaperTradingOnce.js.
  PAPER-only, dry-run default, --execute-paper still required; options default
  plan_only. 63 network-free tests (406 total). Part G (strategy-settings file)
  was DEFERRED as not needed for CLI-driven caps.
- EOD constraint-change recommendations are COMMITTED (`59b953f`):
  src/paper/constraintRecommendations.js + sendPaperEodReport.js integration. The
  EOD report ANALYZES the day's paper_trades/rejected_trades and RECOMMENDS
  (never auto-applies) conservative, bounded manual `.env` constraint edits, with
  hard guarantees: the bot NEVER edits .env/.env.example and NEVER recommends
  LIVE_TRADING_ENABLED=true. 19 network-free tests (425 total).
- The FULL learning/strategy + research-source system is COMMITTED (`385ba4c`):
  a non-secret runtime strategy file (config/strategy-settings.example.json +
  data/strategy-settings.json gitignored, written ONLY via --write) with
  src/config/strategySettings.js; a learning engine (src/paper/strategyLearning.js)
  + scripts/updateStrategySettingsFromLearning.js (dry-run default; --write writes
  ONLY the data file; notes APPENDED deduped+capped to avoid bloat); an approved
  research-source allow-list (config/research-sources.example.json +
  src/research/researchSources.js) + a SELECTION-ONLY scrape-target selector
  (src/research/scrapeTargetSelector.js + scripts/selectResearchTargetsOnce.js,
  no network/fetch); and the EOD report extended with strategy-settings
  recommendations + a next-day research-focus plan. .env stays manual-only;
  never enables live trading. 38 network-free tests (463 total).

## Latest Confirmed Commit
- Latest committed: `e2ee6d6` - fix(paper): run fresh news decision cycle in
  paper loop. The loop now performs fresh Alpaca news ingest, real-model
  classification of newly inserted events, fresh unprocessed `model_v1`
  selection, and the existing PAPER proposal/risk/order path each open-market
  iteration. Heartbeat outcomes distinguish no-news, no-score, threshold, risk,
  processed, and broker-error cases. Tests: 474/474.
- Previous: `385ba4c` — feat(strategy): learning-based strategy settings
  + research-source selection. A non-secret runtime strategy file
  (config/strategy-settings.example.json + src/config/strategySettings.js;
  data/strategy-settings.json gitignored, written ONLY with --write, never .env,
  notes appended deduped+capped); a bounded learning engine
  (src/paper/strategyLearning.js) + scripts/updateStrategySettingsFromLearning.js
  (dry-run default); an approved research-source allow-list
  (config/research-sources.example.json + src/research/researchSources.js) + a
  SELECTION-ONLY scrape-target selector (src/research/scrapeTargetSelector.js +
  scripts/selectResearchTargetsOnce.js; no network/fetch). EOD report extended
  with strategy recs + research focus. 38 new network-free tests; 463/463.
- Previous: `59b953f` — feat(paper): EOD report recommends manual .env
  constraint changes. A read-only analysis layer
  (src/paper/constraintRecommendations.js) turns the day's
  paper_trades/rejected_trades into conservative, bounded recommendations for
  MANUAL .env edits (pct +/-25%, count +/-20%, threshold +/-0.05). The bot never
  edits .env and never recommends LIVE_TRADING_ENABLED=true. sendPaperEodReport
  appends a "Recommended manual .env changes" section (local + Discord). 19 new
  network-free tests; 425/425.
- Previous: `b3387d5` — feat(paper): advanced PAPER trading — long/short,
  options, margin, market-hours loop. Account/positions snapshots + OCC option
  market orders on the (still paper-only) client; margin-aware risk
  (accountCapabilities + paperRisk) with notional/exposure/daily caps; long+short
  equity proposals; single-leg long options by explicit OCC --option-symbol
  (plan_only default); a bounded dry-run-default market-hours loop reusing the
  one-shot. --execute-paper still required; options also need --options-mode
  execute_paper + a verified options capability. 63 new network-free tests;
  406/406 passing.
- Previous: `0bb590c` — feat(notifications): add Discord webhook
  verification and paper EOD report. A PAPER-only Discord delivery path: a
  webhook client (injected HTTP; the webhook URL and its token are redacted from
  all errors and never printed/persisted), scripts/smokeDiscordWebhook.js (a
  channel connection test), and scripts/sendPaperEodReport.js (read-only EOD
  summary of paper_trades / rejected_trades; DRY RUN default, posts only with
  --send-discord/--test-message and a configured webhook). config.discord +
  .env.example placeholders. 24 new network-free tests; 343/343 passing.
- Previous: `df1931f` — feat(paper): manual one-shot PAPER trade
  vertical slice (Phase 5). Select a real-model-scored event → conservative
  equity-long / market-buy proposal → minimal risk gate → a single Alpaca PAPER
  market order ONLY with explicit --execute-paper (dry-run default). Order
  client hard-wired to the paper endpoint (no live path, no baseUrl override);
  keys in headers only and redacted from errors. Outcomes persist to
  migration-001 paper_trades / rejected_trades (no schema change). 39 new
  network-free tests; 319/319 passing.
- Previous: `67e745f` — feat(measurement): window diagnostics +
  baseline-lookback widening (manual) (scripts/measureReactionsOnce.js +
  scripts/runMvpPipelineOnce.js + src/eventStudy/measureReactions.js + their
  tests). measureEvent's summary now carries a sanitized `window` block
  (baseline-lookback start, reaction-window end, lookback ms, and the COUNT of
  trades the source returned — null on source_error). A new opt-in
  `--baseline-lookback-minutes N` flag (capped at 390 = one RTH session) widens
  the baseline search on the thin IEX feed; default behavior unchanged. Engine
  change is additive (no schema/measurement_status change). 11 new network-free
  tests; 280/280 passing.
- Previous: `8bef1f9` — docs(status): record MVP pipeline targeting fix
  (STATUS.md only).
- Previous: `5afd67f` — feat(mvp-pipeline): target fresh events for
  measurement (8 new network-free tests).
- Previous: `009ed81` — docs(status): record measurement diagnostics +
  baseline-lookback widening (STATUS.md only).
- Previous: `89c7eb5` — docs(status): record Phase 5 one-shot paper slice commit
  (STATUS.md only).
- Previous: `452f690` — docs(status): record EOD constraint recommendations
  (STATUS.md only).
- This STATUS update is committed separately as
  `docs(status): record learning/strategy + research system` (STATUS.md only).
  (verify committed head with `git log -1 --oneline`)

## Current Phase
Phase 2 functionally complete (contract, normalization, four adapter
skeletons, ingestion, persistence, registry tests, docs).
Phase 3 — Sentiment & Classification: fixture-only implementation started
(contract/parser/fixture classifier only; no model calls, no storage writer).
Phase B (manual MVP loop) — manual scoring + single end-to-end pipeline
command IMPLEMENTED and COMMITTED (`5c26e57`); default scoring is a
deterministic model-free baseline (no model calls). RUN LOCALLY end-to-end
against the live Alpaca feed with real .env credentials: the loop produced
news_events, sentiment_scores, and price_reactions rows through the existing
insert paths. No orders placed, no trading occurred.
Phase C (real model-backed classifier) — IMPLEMENTED and COMMITTED
(`691900b`): createModelClassifier sits behind the existing Classifier
contract and reuses the existing parseModelResponse + insertSentimentScore
path. Explicit/opt-in via `--classifier real_model`; default stays
manual_baseline. Config-only credentials, sanitized errors, never throws on
bad calls, and never exercised by npm test (fake HTTP only). RUN ONCE
standalone against the live model API (model claude-opus-4-8, prompt
model_v1): one event classified and stored through insertSentimentScore
(parsed=1), sanitized output only. The FULL MVP PIPELINE has NOW ALSO been
run locally with `--classifier real_model`: real Alpaca news ingest -> real
model-backed scoring -> real Alpaca Trades measurement path -> read-only
research summary, all through existing insert paths, with sanitized output
and no orders/trading. Measurement still produced no_baseline=6 (no usable
baseline trade, likely outside market hours), so this proves the real
end-to-end research WIRING, not signal quality or measured returns.
Phase 5 (Paper Trading Journal) — FIRST VERTICAL SLICE COMMITTED (`df1931f`).
The project intentionally accelerated to PAPER
trading WITHOUT waiting for event-study-ready > 0: a manual one-shot path
(scripts/runPaperTradingOnce.js) selects one real-model-scored event, builds a
conservative equity-long / market-buy / whole-share proposal, runs a minimal
risk gate, and — ONLY with the explicit --execute-paper flag and configured
paper credentials — submits a single Alpaca PAPER market order, persisting the
outcome to paper_trades (executed) or rejected_trades (refused). DRY RUN is the
default and sends nothing. PAPER-ONLY by construction (the order client is
hard-wired to the paper endpoint; no live endpoint exists anywhere); live
trading remains impossible/default-disabled. No shorts, no options, no margin,
no scheduling/loop yet.

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
- Phase B manual MVP loop RUN LOCALLY end-to-end (real .env credentials),
  proving the full research loop with real ingest, deterministic manual
  scoring, the real Alpaca Trades measurement path, and the read-only
  research summary. No orders were placed and no trading occurred.
  Standalone classification (node --env-file=.env
  scripts/classifyNewsOnce.js --limit 1): model manual_baseline / prompt
  manual_v1; selected 1, classified 1, stored 1, skipped 0, failed 0;
  parser statuses parsed=1; classification COMPLETE — rows written through
  insertSentimentScore. Full pipeline (node --env-file=.env
  scripts/runMvpPipelineOnce.js --symbols AAPL --ingest-limit 5
  --classify-limit 1 --measure-limit 1): Stage 1 ingest via provider
  "alpaca" fetched 5, inserted 5, duplicates 0, failed 0, inserted ids
  6–10; Stage 2 classify/score with manual_baseline / manual_v1 selected 1,
  classified 1, stored 1, skipped 0, failed 0, parser statuses parsed=1;
  Stage 3 measure via source alpaca_iex selected 1, measured 1, failed 0
  across horizons 10s/1m/5m/30m/1h/eod, statuses no_baseline=6, 6 rows
  written / 6 replaced (event 1 AAPL no_baseline for all six horizons);
  Stage 4 research summary news_events 10, sentiment_scores 2,
  price_reactions 6, measurement_status no_baseline=6, horizon counts
  10s=1/1m=1/5m=1/30m=1/1h=1/eod=1, no measured rows yet (no measured-return
  averages, no recent measured rows). This proves the loop end-to-end at the
  database level: real Alpaca news ingest -> deterministic manual scoring ->
  real Alpaca Trades measurement path -> read-only research summary, all
  through existing insert paths. manual_baseline is a NEUTRAL placeholder; it
  proves pipeline wiring, NOT signal quality. The no_baseline=6 outcome is
  the expected, correct failures-as-data result (no usable baseline trade,
  likely outside market hours); real measured returns still require
  market-hours or otherwise measurable trade windows. git status clean after
  the run; the database file and .env remained ignored/untracked. No
  trading, no paper orders.
- First REAL model-backed classifier (src/sentiment/modelClassifier.js),
  Phase C: createModelClassifier(config, options) sits behind the EXISTING
  Classifier contract — a sibling to the fixture classifier with the same
  contract, the same parseModelResponse, and the same insertSentimentScore
  storage path; the only difference is the responder is a real Anthropic
  Messages API call (raw HTTP via injectable fetch — the project stays
  zero-dependency, no SDK). Safety mirrors the real Alpaca transports:
  DISABLED BY DEFAULT / explicit construction only (throws "not configured"
  without ANTHROPIC_API_KEY; no import-time/startup/scheduler/npm-test path);
  credentials read ONLY from config.model.anthropicApiKey and sent in an
  x-api-key header only (never logged/returned/thrown/persisted); errors are
  sanitized/redacted; the HTTP function is injectable so npm test is fully
  offline. classifyEvent NEVER throws — transport/HTTP failures become
  parserStatus 'model_error', and usable model text flows through the
  existing parser UNCHANGED so malformed/missing-field/out-of-range outcomes
  are stored as data exactly as before (raw_response preserved byte-for-byte).
  Identity: model = the configured model id (default claude-opus-4-8, override
  via MODEL_CLASSIFIER_MODEL), prompt_version = "model_v1". Exposed as an
  explicit, opt-in CLI choice on both manual scripts via
  `--classifier manual_baseline|real_model` (default stays manual_baseline);
  buildClassifier() builds the chosen one and real_model fails clearly without
  a key. New config block config.model (anthropicApiKey + classifierModel),
  read only in src/config.js. 22 new network-free fake-HTTP tests
  (tests/modelClassifier.test.js plus selection tests on the two script test
  files): not-configured throws, key-in-header-only (never in body),
  success->parsed mapping, malformed/missing-field/out-of-range->their
  statuses, HTTP-error and transport-throw->sanitized model_error (key
  redacted), non-JSON/empty->model_error, classifyEvent never throws,
  prompt-builder whitelist (no raw_payload, no secrets), and import safety.
  No live model call in npm test; no trading, schema, dependency, or
  parser/storage semantic changes. NOT YET RUN against a live model.
- Phase C real model classifier RUN LOCALLY once (real .env credentials,
  command: node --env-file=.env scripts/classifyNewsOnce.js --classifier
  real_model --limit 1): model claude-opus-4-8 / prompt model_v1; selected 1
  event, classified 1, stored 1, skipped 0, failed 0; parser statuses
  parsed=1; classification COMPLETE — row written through insertSentimentScore.
  This proves the real model-backed classifier path end to end: a live
  Anthropic Messages API call produced one parsed classification that flowed
  through the existing parseModelResponse and insertSentimentScore path into
  sentiment_scores, with model=<configured id> / prompt_version="model_v1".
  Output stayed sanitized — no API key, auth header, request URL, raw news
  payload, or raw model response was printed. This proves real model classifier
  WIRING, NOT signal quality; manual_baseline remains the default. No trading,
  no paper orders.
- Full MVP pipeline RUN LOCALLY with the REAL model classifier (real .env
  credentials, command: node --env-file=.env scripts/runMvpPipelineOnce.js
  --classifier real_model --symbols AAPL --ingest-limit 5 --classify-limit 1
  --measure-limit 1). Stage 1 ingest via provider "alpaca" fetched 5,
  inserted 0, duplicates 5, failed 0, no inserted ids (the small AAPL sample
  was already in the DB — provider-scoped dedup held). Stage 2 classify/score
  with model claude-opus-4-8 / prompt model_v1 selected 1, classified 1,
  stored 1, skipped 0, failed 0, parser statuses parsed=1 — a real
  model-backed sentiment_scores row written through insertSentimentScore.
  Stage 3 measure via source alpaca_iex selected 1, measured 1, failed 0
  across horizons 10s/1m/5m/30m/1h/eod, statuses no_baseline=6, 6 rows
  written / 6 replaced (event 1 AAPL no_baseline for all six horizons).
  Stage 4 research summary: news_events 10, sentiment_scores 4,
  price_reactions 6, measurement_status no_baseline=6, horizon counts
  10s=1/1m=1/5m=1/30m=1/1h=1/eod=1, no measured rows yet (no measured-return
  averages, no recent measured rows). This proves the full MVP research loop
  end-to-end with real Alpaca news ingest, real model-backed classification,
  the real Alpaca Trades measurement path, and read-only reporting — all
  through existing insert paths. No orders were placed and no trading
  occurred. Output stayed sanitized — no API key, auth header, request URL,
  raw news payload, raw trade payload, or raw model response was printed.
  This proves the real end-to-end research WIRING, NOT signal quality or
  profitability. The no_baseline=6 outcome means measured returns are still
  unavailable (no usable baseline trade, likely outside market hours); a
  market-hours measurable-event run is required before event-study expectancy
  can be evaluated. git status clean after the run; the database file and .env
  remained ignored/untracked.
- Measurement-candidate finder (scripts/listMeasurementCandidates.js,
  documented in README), committed as `a152a66`: manual-only, READ-ONLY
  (SELECTs only — no writes, no migrations, no network, no credentials needed);
  CLI-guarded (import is side-effect free). It exists to make measured-return
  runs repeatable: past runs picked events blindly and produced all-no_baseline
  rows, so this helper ranks EXISTING news_events (with both ticker and
  received_at) by how likely a measurement is to yield a measured return.
  Default mode keeps MARKET-HOURS, not-yet-measured candidates ranked best-first
  (market-hours, then unmeasured, then newest received_at); `--all` lists every
  eligible event, `--ticker` filters to one symbol, `--limit` defaults to 10
  (hard max 50). Market hours is an APPROXIMATION via Intl
  (Mon-Fri 09:30-16:00 America/New_York, DST handled automatically); it does
  NOT model market holidays or half-days (real session calendar still deferred).
  Per candidate it prints a strict whitelist — event id, ticker, provider,
  received_at, an Eastern-time label, market_hours flag, model_v1 score flag,
  measured flag, and price_reactions status counts — plus the exact
  `measureReactionsOnce.js --ids <id>` command and a combined top-N command
  (capped at 5, the measure script's --ids limit). Never headlines, bodies,
  raw_payload, raw model responses, keys, or any free-text content. model_v1
  detection imports MODEL_PROMPT_VERSION from the model classifier (the real
  model's signature prompt_version). 13 network-free tests using an in-memory DB
  (arg parsing/caps, EDT/EST/boundary/weekend market-hours, ranking/filtering,
  ticker filter, limit cap, no-event behavior, suggested-command formatting +
  cap, and output redaction). NOT a measurement path itself — it only suggests
  the existing capped measure command; no schema/engine/measurement_status
  changes, no trading, no model calls.
- Event-study readiness counts added to the research summary
  (scripts/reportEventStudySummary.js, same commit): collectSummary now also
  returns measuredRowCount, modelV1ScoreCount (real-model model_v1 scores), and
  readyEventCount — events that have BOTH a model_v1 score AND at least one
  measured price_reaction, i.e. the rows an event-study expectancy readout can
  actually use (while this is 0, no expectancy can be computed yet).
  buildSummaryReport renders three new lines and tolerates summaries lacking the
  fields (defaults to 0), so the MVP pipeline's composed report keeps working.
  2 new tests plus readiness assertions on the empty-database test; still
  read-only and paste-safe. NOT YET RUN against the live database.
- MVP pipeline measurement targeting fix (scripts/runMvpPipelineOnce.js),
  committed as `5afd67f`: the measure stage previously called
  selectEvents(limit) which orders by received_at ASC and so kept re-measuring
  the OLDEST event (event 1 -> repeated no_baseline), even after a run had just
  ingested/scored fresh events. New exported selectMeasurementEvents() chooses
  measurement targets in a fixed priority order — (1) explicit --measure-ids,
  (2) event ids the ingest stage inserted THIS run, (3) event ids the classify
  stage scored THIS run, (4) oldest-eligible fallback ONLY when no current-run
  ids are available. A higher-priority current-run set that yields no eligible
  rows falls through to the next source, so a duplicate-only ingest measures a
  sensible current candidate (classified) rather than blindly event 1. Every
  candidate set still flows through the EXISTING capped selectEvents helper, so
  eligibility (ticker + received_at) and the hard measure cap (default 1, max 5)
  are unchanged; writes still go ONLY through measureEvents -> insertPriceReaction;
  no measurement_status / event-study engine / schema change. New CLI flag
  --measure-ids 6,7,8 (deduped, positive ints, truncated to the hard cap). The
  stage-3 report prints why the target was chosen
  (`measurement target — source: explicit ids|inserted ids|classified ids|fallback selection`).
  8 new network-free tests (in-memory DB, mock provider, manual classifier,
  fixture PriceSource): --measure-ids parse/dedup/cap, selectMeasurementEvents
  priority + cap, inserted-preferred-over-event-1, classified fallback when
  ingest is skipped, explicit-ids-win, duplicate-only-ingest avoids event 1,
  report shows selection source, and headline redaction. No model/live calls in
  npm test. NOT YET RUN against the live feed.
- Measurement window diagnostics + baseline-lookback widening
  (src/eventStudy/measureReactions.js + scripts/measureReactionsOnce.js +
  scripts/runMvpPipelineOnce.js), committed as `67e745f`: to debug the
  all-no_baseline outcomes on the thin IEX feed, measureEvent's returned summary
  now includes a sanitized `window` block — baseline-lookback start
  (baselineFromIso), final reaction-window end (reactionToIso), the lookback ms
  used, the price source name, and the COUNT of trades the source returned
  (tradeCount; stays null on source_error, never invented). The two manual
  measurement scripts render this as a "window diagnostics" section and a
  `lookback:` header line (counts/timestamps/source only — never prices, raw
  trade payloads, or secrets). A new opt-in `--baseline-lookback-minutes N` flag
  on both measureReactionsOnce.js and runMvpPipelineOnce.js widens how far back
  the engine looks for a baseline trade; it is null by default (engine default
  15m, behavior unchanged) and capped to [1, 390] minutes (one full regular
  session) so the requested trade window can never balloon. A wider lookback
  only moves the REQUESTED baseline-window start earlier — it never changes
  horizon targets, the anchor (received_at), measurement_status semantics, the
  selected event, or any look-ahead guarantee. The engine summary change is
  additive (no schema/migration change); 11 new network-free tests (engine
  window diagnostics + a wider-lookback baseline rescue + source_error null
  count; script flag parse/cap, requested-window widening via a recording
  source, sanitized diagnostics rendering, custom-lookback header; pipeline flag
  threading). NOT YET RUN against the live feed during market hours.
- Phase 5 PAPER-trading first vertical slice (committed as `df1931f`):
  * src/config.js: new config.alpacaPaper credentials block. It REUSES the
    existing account-level Alpaca key pair (the same ALPACA_API_KEY_ID/SECRET
    env vars — no new secrets, so .env.example is unchanged); read only here,
    never logged/persisted. There is intentionally NO base-URL field — the paper
    endpoint is hard-coded in the client and there is NO live-endpoint config.
  * src/paper/alpacaPaperClient.js: the project's first and ONLY order-submitting
    client. createAlpacaPaperClient(config, {httpFetch}) behind the same safety
    regime as the read-only Alpaca clients — explicit construction, throws "not
    configured" without paper keys, injected fetch (npm test fully offline),
    keys in headers only (never body/logs), sanitized/redacted errors.
    submitMarketOrder({symbol, qty, side='buy'}) POSTs ONE market order
    (type 'market', time_in_force 'day') to the HARD-CODED paper endpoint
    (PAPER_BASE_URL = https://paper-api.alpaca.markets). There is NO baseUrl
    option and no env override, so it can never point at the live API; returns a
    sanitized order whitelist (id/status/qty/...), never the raw payload.
  * src/paper/paperTradeProposal.js: assessProposal() — a PURE risk gate
    (no DB/network/clock) for the slice's ONLY trade shape: equity LONG, market
    BUY, whole shares. Rejects (with a clear reason) unless ticker is in the CLI
    allow-list, parser_status is parsed/fallback_used, direction is 'up' (no
    shorts), and confidence/impact/sentiment clear conservative DEFAULT_THRESHOLDS
    (0.6 / 0.5 / 0.3). DEFAULT_QTY=1, MAX_QTY=100 (clampQty). Plus the
    paper_trades / rejected_trades writers (migration-001 tables; NO schema
    change) and summarizeScore() which strips raw_response/detail.
  * scripts/runPaperTradingOnce.js: the manual entry point. parseArgs
    (--symbols, --qty, --event-id, --confidence/-impact/-sentiment-threshold,
    --execute-paper); selectRecentScoredEvent() picks one recent model_v1-scored
    event (whitelisted columns only); runPaperTradeOnce() assesses → on reject
    writes rejected_trades; on accept+dry-run writes nothing; on accept+execute
    submits the paper order and writes paper_trades (order errors are recorded
    sanitized, never written as a trade). DRY RUN default; --execute-paper +
    configured creds required to send. buildPaperReport() is a sanitized
    whitelist. CLI-guarded (import runs nothing).
  * 39 new network-free tests across tests/alpacaPaperClient.test.js,
    tests/paperTradeProposal.test.js, tests/runPaperTradingOnce.test.js:
    not-configured throws, paper-endpoint-only (never live, even with
    liveTradingEnabled config), keys-in-headers-not-body, HTTP/network errors
    redacted, sanitized order mapping; risk accept/reject rules incl. no-shorts
    and threshold gates, writers + validation; dry-run sends nothing,
    --execute-paper required, missing-creds fails safely, fake-HTTP success
    stores a paper_trade, fake-HTTP error redacted, rejection stores
    rejected_trades, reports sanitized (no raw response/headline/rationale),
    zero real network, import safety. package.json registers the 3 files.
  NOT YET RUN against the live paper account.
- Discord verification + end-of-day report slice (committed as `0bb590c`):
  * src/config.js: new config.discord block (webhookUrl + serverId + channelId).
    webhookUrl is secret-ish (embeds a token) — read only here, never printed/
    persisted; serverId/channelId are non-secret metadata. .env.example gains
    DISCORD_WEBHOOK_URL/SERVER_ID/CHANNEL_ID placeholders (empty).
  * src/notifications/discordWebhookClient.js: createDiscordWebhookClient(config,
    {httpFetch}) — explicit construction, throws "not configured" without a
    webhook URL, injected fetch (npm test offline), POSTs {content} to the
    webhook, truncates to Discord's 2000-char limit, and REDACTS both the URL and
    its token from every error (the URL/token can never leak). describeDiscordTarget()
    returns sanitized metadata (webhookConfigured + ids, never the URL).
  * scripts/smokeDiscordWebhook.js: manual connection test. Prints sanitized
    server/channel ids + webhook-configured + send result; sends ONE fixed test
    message ("ExaltedFable Discord connection test — paper trading reports
    enabled.") when configured; fails clearly when the webhook is missing; never
    prints the URL. CLI-guarded.
  * scripts/sendPaperEodReport.js: READ-ONLY end-of-day summary of
    paper_trades / rejected_trades for one trading day (--day, default today
    UTC). collectEodData() aggregates counts (proposals/orders/fills/long/short/
    rejections + recurring reasons/approx P&L); buildEodReport() renders a
    sanitized narrative with the required sections (what it did / why / went well
    / went poorly / mistakes & lessons / next-day ideas), or a safe placeholder
    when there are no records (still proves delivery). DRY RUN by default; posts
    to Discord ONLY with --send-discord (or --test-message), and only with a
    configured webhook (missing webhook fails clearly, never a silent skip).
    runEodReport() is dependency-injected (fake Discord client in tests).
  * 24 new network-free tests (tests/discordWebhookClient.test.js,
    tests/smokeDiscordWebhook.test.js, tests/sendPaperEodReport.test.js):
    not-configured throws, send success/{content}/truncation, URL+token redacted
    from HTTP + network errors, metadata-only describe; smoke formatter never
    leaks the URL + exact test message; EOD arg parsing, day filter, aggregation,
    required narrative sections + placeholder, dry-run sends nothing,
    send/test-message use the injected client, refuse-to-send without a client,
    no raw response/headline leakage, zero real network. package.json registers
    the 3 files. NOT YET RUN against a live Discord webhook.
- Phase 5 ADVANCED PAPER trading (committed as `b3387d5`):
  * src/paper/alpacaPaperClient.js EXTENDED: getAccount() + getPositions()
    (sanitized snapshots) and submitOptionMarketOrder() (OCC market order)
    alongside the existing equity submitMarketOrder (buy=long, sell=short). All
    GET/POST share one sanitized HTTP helper; paper endpoint stays hard-coded
    (no live, no baseUrl option); keys redacted from every error.
  * src/paper/accountCapabilities.js: deriveCapabilities(account) infers
    margin/short eligibility (multiplier >= 2 AND equity >= $2000) and options
    eligibility (clearly-reported level >= 1; unknown => fail closed); plus
    gross/symbol exposure helpers and an option-position finder. Pure.
  * src/paper/paperRisk.js: assessRisk() — margin-aware gate. Rejects blocked
    accounts, ineligible shorts, sub-equity shorts, insufficient buying power,
    and breaches of --max-order-notional / --max-symbol-exposure /
    --max-gross-exposure / --max-daily-paper-orders / --max-daily-paper-notional
    / --option-max-premium. Fail-safe: an EQUITY execute with no reference price
    is refused; options with no quote are approved with an explicit "premium
    UNVERIFIED" caveat (bounded by --option-contract-limit; paper-only). Pure.
  * src/paper/paperTradeProposal.js: assessProposal() now does LONG (up->buy) and
    SHORT (down->sell, only with --allow-shorts and sentiment <= -threshold);
    unclear/none rejected. Writers unchanged (migration-001 tables).
  * src/paper/optionsProposal.js: proposeOption() — single-leg LONG call/put only,
    intent from direction (bullish_call/bearish_put), EXPLICIT OCC --option-symbol
    (validated: type matches intent, underlying in allow-list, expiry window),
    plan_only by default. No spreads/multi-leg/auto-rolls/uncovered writing.
  * src/paper/marketHours.js: US regular-session approximation (Mon-Fri
    09:30-16:00 ET via Intl; weekends skipped; holidays NOT modeled). Pure.
  * src/paper/paperTradingLoop.js + scripts/runPaperTradingLoop.js: a bounded
    market-hours loop that REUSES the one-shot logic (executeOneShot) — no trade
    logic duplicated. Dry-run default; >= 5-min interval floor; max-iteration cap;
    sanitized heartbeats; graceful SIGINT; optional --send-discord-eod-report.
  * scripts/runPaperTradingOnce.js: integrates all of the above (parseArgs for
    every advanced/cap flag; fetchAccountState + fetchReferencePrice via the
    paper + existing trades clients; equity AND option proposals each risk-gated,
    dry-run/executed, and persisted distinctly). DRY RUN default; --execute-paper
    required; sanitized report shows account capability + both legs.
  * 63 new network-free tests across tests/alpacaPaperClient.test.js (account/
    positions/short/option), tests/accountCapabilities.test.js, paperRisk.test.js,
    optionsProposal.test.js, marketHours.test.js, runPaperTradingOnce.test.js
    (long/short/options/margin integration), runPaperTradingLoop.test.js (market
    gating, bounds, Ctrl+C, heartbeat). 406 total; npm test fully offline (fake
    HTTP / injected clients/clock; no order or Discord post is ever sent).
    NOT YET RUN against the live paper account.
- EOD constraint-change recommendations (committed `59b953f`):
  * src/paper/constraintRecommendations.js: buildConstraintRecommendations()
    turns the day's sanitized EOD aggregates (wins/losses/orders/rejections by
    category) into conservative, BOUNDED manual-.env-edit recommendations. Each
    rec carries variable, action, current value ("(not set)" when unwired),
    recommended value, reason, confidence (low|medium|high), urgency
    (monitor|recommended|important), evidence, and an exact manual_edit_line
    (VAR=value). Bounds: pct ±25%, count ±20%, threshold ±0.05 per update, never
    above each variable's ceiling, never unlimited. Decreases risk readily after
    losses/repeated-rejections/drawdowns/excessive-orders; only suggests a SMALL
    bounded INCREASE after strong positive evidence over >= minSampleSize trades.
    HARD GUARANTEES: never edits any file; never emits LIVE_TRADING_ENABLED=true
    (only ever "=false"); sanitized output only.
  * scripts/sendPaperEodReport.js: collectEodData now also counts winning/losing
    trades; runEodReport computes recommendations from the day's data + the
    CURRENT constraints read through config ONLY (currentConstraintsFromConfig —
    never the raw .env), and buildEodReport appends a "Recommended manual .env
    changes" section (with a "No changes…" message when empty and a "The bot did
    not edit .env" caution). The same section flows into the Discord message
    (sanitized; client truncates to 2000 chars). New flags
    --include-constraint-recommendations (default on) / --no-constraint-recommendations.
  * 19 new network-free tests (tests/constraintRecommendations.test.js +
    additions to tests/sendPaperEodReport.test.js): no-data/insufficient ->
    none; losing day/notional/exposure/excessive-orders/options/shorts -> the
    right conservative rec; strong evidence -> small bounded increase; bounds
    respected; never enables live trading; section rendered in the report and no
    secrets/raw text leak. 425 total; fully offline.
- Learning/strategy/research system (committed `385ba4c`):
  * src/config/strategySettings.js + config/strategy-settings.example.json: a
    NON-SECRET runtime strategy file. validate/cap every field (drops unknown +
    secret-like + LIVE_TRADING_ENABLED keys; enforces the loop interval floor);
    load runtime data/ override else example else defaults; appendNotes()
    de-dupes + caps (NOTES_CAP=50) to prevent bloat; writeStrategySettings()
    writes ONLY the data file and refuses any .env path. .gitignore now ignores
    data/strategy-settings.json.
  * src/paper/strategyLearning.js + scripts/updateStrategySettingsFromLearning.js:
    bounded, conservative strategy-setting recommendations (notional ±25%, counts
    ±20%, thresholds ±0.05; floors enforced; small increase only on strong
    evidence) + a next-day research-focus plan. Dry-run by default; --write
    applies changes to data/strategy-settings.json and APPENDS notes; --format
    text|json; --include-env-recommendations adds the manual .env suggestions.
    Never writes .env, never enables live trading.
  * config/research-sources.example.json + src/research/researchSources.js +
    src/research/scrapeTargetSelector.js + scripts/selectResearchTargetsOnce.js:
    an approved source allow-list + a SELECTION-ONLY target planner. No network,
    no fetching, no robots/paywall/login bypass; isAllowedUrl rejects any
    non-allow-listed URL; gated sources never selected; --fetch is not honored.
  * scripts/sendPaperEodReport.js: EOD report now also renders strategy-settings
    recommendations + the research-focus plan (suppressible via
    --no-strategy-recommendations).
  * 38 new network-free tests across strategySettings, strategyLearning,
    updateStrategySettingsFromLearning, researchSources, scrapeTargetSelector,
    selectResearchTargetsOnce + sendPaperEodReport additions. 463 total; fully
    offline (fake fs / in-memory DB / committed example configs; no disk .env
    writes, no network).

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
- src/sentiment is local-by-default: the contract, parser, fixture classifier,
  and manual baseline make no model/API/network calls. The one real model path
  is src/sentiment/modelClassifier.js, which is DISABLED BY DEFAULT and only
  reaches the network when explicitly constructed with a configured key.
  Provider-supplied sentiment remains in raw_payload only.
- sentiment_scores rows are written ONLY via insertSentimentScore (directly or
  through the optional classifyAndStore/ingestAndClassify stage). Classification
  is a separate optional stage that can never block or delete news_events rows.
  Two classifiers share that path: the manual baseline
  (scripts/classifyNewsOnce.js → createFixtureClassifier wrapped with a
  deterministic local responder; neutral PLACEHOLDER, model="manual_baseline",
  prompt_version="manual_v1", no model/keys/network) and the real model
  classifier (createModelClassifier; opt-in via --classifier real_model;
  model=<configured id>, prompt_version="model_v1"; key via config only;
  sanitized errors; never throws; never called in npm test). No trading logic
  in either.
- The whole manual research loop now also has a single end-to-end entry point
  (scripts/runMvpPipelineOnce.js): optional ingest -> manual scoring -> capped
  measurement -> read-only summary, composed entirely from existing paths and
  report builders. It is RESEARCH-ONLY (no trading/order calls), CLI-guarded,
  and reports SKIPPED stages plus no_baseline/no_reaction outcomes as data. Its
  measurement stage now TARGETS FRESH/CURRENT-RUN events (selectMeasurementEvents:
  explicit --measure-ids > inserted-this-run > classified-this-run > oldest
  fallback) so a market-hours run measures what it just ingested/scored instead
  of always event 1; the chosen source is printed in the stage-3 report.
- Read-only research tooling over the local database: the research summary
  (scripts/reportEventStudySummary.js) now also reports event-study readiness
  (measured rows, model_v1 score count, and events ready with both a model_v1
  score and a measured reaction), and a measurement-candidate finder
  (scripts/listMeasurementCandidates.js) ranks existing news_events into
  paste-safe measure suggestions. Both are SELECT-only, need no credentials or
  network, never write, and reuse the existing measure command rather than
  measuring themselves.
- src/paper is the new PAPER-trading layer (Phase 5, committed `df1931f`). It is
  the ONLY place that can submit an order, and it can only submit to the Alpaca
  paper endpoint: the order client hard-codes PAPER_BASE_URL and exposes no
  live-endpoint option, so live trading stays impossible regardless of
  config.liveTradingEnabled (which still no code consumes for routing). The
  proposal/risk layer is pure and conservative (equity long, market buy, whole
  shares, no shorts/options/margin); orders fire only via the manual
  scripts/runPaperTradingOnce.js with the explicit --execute-paper flag and
  configured paper credentials. Default is dry-run; npm test never sends an
  order (injected fake HTTP / fake client only). Outcomes persist through the
  existing migration-001 paper_trades / rejected_trades tables (no schema
  change).
- src/notifications is the new outbound-notifications layer (Discord slice,
  committed `0bb590c`). discordWebhookClient is the ONLY place a Discord message can be
  sent; it requires config.discord.webhookUrl, redacts the URL/token from all
  errors, and uses injected HTTP (npm test never posts). The EOD report
  (scripts/sendPaperEodReport.js) is read-only over paper_trades/rejected_trades
  and dry-run by default; it sends only with --send-discord and a configured
  webhook. No trading logic and no market/model calls live in this layer.
- src/paper now holds the ADVANCED PAPER stack (committed `b3387d5`): the order client
  is still the ONLY order path and still paper-endpoint-only (equity buy/sell +
  OCC option market orders). accountCapabilities/paperRisk add margin-aware
  gating; optionsProposal adds explicit-OCC long calls/puts (plan_only default);
  marketHours/paperTradingLoop add a bounded, dry-run-default market-hours loop
  that reuses the one-shot. Live trading remains impossible/disabled; orders fire
  only via --execute-paper, options additionally via --options-mode execute_paper
  + a verified options capability. npm test never sends an order (fake HTTP /
  injected clients/clock).
- The EOD report (scripts/sendPaperEodReport.js) now also RECOMMENDS manual
  .env constraint edits via src/paper/constraintRecommendations.js — a read-only
  analysis layer. It NEVER edits .env/.env.example/any file and NEVER recommends
  enabling live trading; it only prints/sends the exact line a human could change.
  Current constraint values are read through config only.
- NEW layers (committed `385ba4c`): src/config/strategySettings.js (non-secret runtime
  strategy file: load/validate/cap/merge + write ONLY the data file, never .env;
  notes appended deduped+capped), src/paper/strategyLearning.js (bounded
  strategy-settings recommendations + next-day research focus), and src/research/*
  (researchSources allow-list + selection-only scrapeTargetSelector). The
  updater (scripts/updateStrategySettingsFromLearning.js) and research selector
  (scripts/selectResearchTargetsOnce.js) are dry-run/selection-only and make no
  network calls. The EOD report now also surfaces strategy-settings
  recommendations + a research-focus plan. .env stays manual-only.
- Tests: Node built-in test runner (`npm test`), 463/463 passing.
- No automatic/scheduled provider, market-data, or model calls. Live
  touchpoints are manual scripts only: news smoke check, news one-shot ingest,
  trades smoke check (each run against the live feed at least once), the capped
  measurement, and the end-to-end pipeline (whose ingest/measure stages reuse
  those same transports). A real MODEL call is now also possible, but only via
  the explicit, opt-in `--classifier real_model` on the classification and
  pipeline scripts — never automatically and never in npm test. No
  execution/trading calls anywhere.

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
  follow-up. The new window diagnostics + `--baseline-lookback-minutes` flag
  (`67e745f`) exist specifically to debug/reduce those no_baseline outcomes when
  that rerun happens.
- The measurement diagnostic `trades seen` is the COUNT of trades the source
  returned for the WHOLE fetched window (baseline-lookback start through the
  furthest horizon target), not a per-horizon count. It is a coarse
  "did we get any ticks?" signal for diagnosing no_baseline, not a per-horizon
  measure. `--baseline-lookback-minutes` is capped at 390; very wide windows can
  still hit the trades client's hard page cap, which surfaces as a sanitized
  source_error (stored as data), never a silent truncation.
- The DEFAULT scorer is still the NEUTRAL placeholder (all-zero sentiment/
  impact/confidence, direction "unclear"). It proves the loop carries a score
  but carries NO predictive content — nothing downstream should treat
  manual_baseline scores as signal. A real model classifier now exists
  (`--classifier real_model`, Phase C) but is opt-in and unproven, so the same
  caution applies until real scores + market-hours measured returns exist.
- The pipeline's ingest hard cap is 20 (vs. 10 for the standalone one-shot
  ingest script); the Alpaca News transport is still single-page only, so even
  at 20 a run fetches one page and does no pagination/backfill.
- Phase B (manual scoring + end-to-end pipeline) is committed, fully tested
  offline, AND now RUN LOCALLY end-to-end against the live feed: the
  manual_baseline path has scored real ingested events and the pipeline has
  been exercised end-to-end with real credentials (sentiment_scores 2,
  price_reactions 6). The run still produced no measured returns
  (no_baseline=6), so signal quality remains unproven — manual_baseline is a
  neutral placeholder and a market-hours measured run is still outstanding.
- Phase C (real model classifier) is committed, fully tested offline, RUN ONCE
  standalone against a live model (parsed=1, one sentiment_scores row,
  sanitized output), AND now RUN through the FULL MVP pipeline with
  `--classifier real_model` (real model score stored + real measurement path
  exercised; sentiment_scores 4, price_reactions 6). The pipeline run still
  produced no measured returns (no_baseline=6), so the only outstanding item is
  a MARKET-HOURS measured readout where real scores and real measured returns
  coexist. Each real run needs ANTHROPIC_API_KEY and bills the Anthropic API.
  Signal quality remains unproven.
- The model classifier relies on the model returning a BARE JSON object
  (enforced by a strict system prompt). If a model wraps output in prose or
  markdown fences, the existing parser records malformed_json (failure-as-data)
  and raw_response is kept byte-for-byte rather than mangled — correct, but it
  means parse rates depend on the model honoring the "JSON only" instruction.
  Structured outputs (output_config.format) are a possible future hardening,
  deliberately omitted to keep the change small and model-agnostic.
- The model classifier default model is claude-opus-4-8 (per Anthropic
  guidance) — higher cost than Haiku for bulk scoring; override with
  MODEL_CLASSIFIER_MODEL. v1 has no thinking, no retries, and no rate-limit
  backoff: one POST, max_tokens 1024, non-streaming; a 429/5xx surfaces as a
  sanitized model_error (stored as data).
- NAMING NOTE: config now has both config.alpacaNews (Alpaca key pair) and
  config.model (anthropicApiKey + classifierModel). The earlier alpacaNews
  naming debt still stands; the new config.model block is cleanly named.
- The measurement-candidate finder's market-hours test is an APPROXIMATION
  (Mon-Fri 09:30-16:00 America/New_York via Intl, DST handled). It does NOT
  model US market holidays or half-days, so an event flagged market_hours=yes on
  a holiday can still measure to no_baseline. It is a heuristic to pick better
  candidates, not a guarantee of a measured return; the real session calendar
  remains deferred to the market-data client's later step. model_v1 detection
  keys on prompt_version='model_v1' (the real model classifier's signature); a
  future second model prompt version would need this widened.
- PAPER-TRADING SLICE SAFETY/LIMITS (Phase 5, committed `df1931f`):
  * PAPER ONLY. The order client targets the hard-coded Alpaca paper endpoint;
    there is no live endpoint, no baseUrl override, and no env var that can point
    it at live. Live trading remains impossible/default-disabled. Do NOT add a
    live path without an explicit, separately reviewed task.
  * Default is DRY RUN (no order). An order is sent only with --execute-paper AND
    configured paper credentials. config.alpacaPaper REUSES the account-level
    ALPACA_API_KEY_ID/SECRET pair (same naming debt as the trades client) — on a
    paper account these authorize paper trading; if a user's keys were ever live
    keys, the endpoint is still paper-only so no live order can result, but the
    keys must be paper-account keys for real use.
  * The slice is intentionally minimal: equity LONG, market BUY, whole shares,
    qty hard-capped at 100, conservative score thresholds. No shorts, no options,
    no margin/notional/buying-power sizing, no take-profit/stop/exit logic, no
    risk_state/daily-loss/exposure/kill-switch wiring yet (those Phase 6 risk
    controls are NOT in this slice). The market order has no price guard, so a
    real execute run fills at the paper market price.
  * paper_trades stores no broker order_id column (migration 001); the Alpaca
    order id is kept in trade_reason text and printed in the report, not in a
    dedicated column. A dedicated column would need a future additive migration.
  * An accepted DRY RUN writes nothing; a rejection writes rejected_trades in ANY
    mode (a logged refusal, not an order). Repeated dry runs on a failing event
    therefore accumulate rejected_trades rows (by design — refusals are data).
  * NOT YET RUN against the live paper account; selection requires existing
    real-model (model_v1) scored events, so run the MVP pipeline /
    classifyNewsOnce --classifier real_model first.
- DISCORD SLICE SAFETY/LIMITS (committed `0bb590c`):
  * The webhook URL is a SECRET (it embeds a token). It is read only via
    config.discord.webhookUrl, never printed/logged/returned/persisted, and is
    redacted from all client errors. DISCORD_SERVER_ID/CHANNEL_ID are metadata
    only and cannot post on their own.
  * Discord sends ONLY from the manual scripts with an explicit flag
    (smokeDiscordWebhook sends a fixed test message; sendPaperEodReport sends only
    with --send-discord/--test-message). npm test never posts (injected fake HTTP).
  * The EOD report has NO learning-log table yet (Phase 5 learning log is a later
    slice). Its narrative is templated from paper_trades/rejected_trades counts +
    our own rejection-reason strings; P&L is whatever pnl_usd holds (null→0 today,
    since exits are not yet computed). "best/worst ticker" is only meaningful once
    realized P&L exists.
  * OPENAI_MODEL wiring (requested in a later prompt) was DEFERRED: the real
    classifier is ANTHROPIC (config.model.classifierModel / MODEL_CLASSIFIER_MODEL,
    default claude-opus-4-8). Wiring an OpenAI model id into the Anthropic call is
    incoherent; needs clarification (rename the existing model env var vs. add a
    real OpenAI provider). No OpenAI changes were made.
- ADVANCED PAPER SLICE SAFETY/LIMITS (committed `b3387d5`):
  * Still PAPER ONLY. The order client is hard-coded to the paper endpoint; there
    is no live endpoint, no baseUrl override, no env override. --execute-paper is
    still required for any order; options need --options-mode execute_paper + a
    verified account options capability too.
  * OPTIONS use an EXPLICIT OCC --option-symbol (no contract discovery in this
    patch). Execution is single-leg LONG calls/puts only — no spreads, no
    multi-leg, no auto-rolls, no uncovered writing; selling is only ever to close.
    There is NO options quote feed, so --option-max-premium CANNOT be pre-verified
    pre-trade; option exposure is bounded by --option-contract-limit only (a
    market order can fill above the stated premium). PAPER-only, so no real money.
  * REFERENCE PRICE for equity notional caps comes from the existing Alpaca
    trades source (latest IEX trade, lagged ~16m). If unavailable, an EQUITY
    execute is REFUSED (fail-safe); a dry run is allowed with an "unverified"
    caveat. Margin/short eligibility is inferred from the paper account snapshot
    (multiplier + equity + options level); it is best-effort, not a broker
    guarantee.
  * paper_trades has NO asset_class/option columns (migration 001), so an option
    fill is stored with ticker=underlying and the OCC symbol/intent in
    trade_reason text (reported distinctly, stored with a marker). A dedicated
    options schema + a learning-log table (deferred Part E) would need additive
    migrations.
  * The market-hours loop is an APPROXIMATION (no US holiday/half-day calendar)
    and is bounded (>= 5-min interval, max-iteration cap, dry-run default). It is
    a foreground manual process — NO daemon/service/Task Scheduler registration.
  * DEFERRED to later reviewed slices: strategy-settings file (Part G), a
    learning-log table + reviewPaperLearningOnce, options contract discovery,
    sell-to-close automation, and OPENAI_MODEL/provider wiring.
  * NOT YET RUN against the live paper account.
- EOD CONSTRAINT-RECOMMENDATIONS LIMITS (committed `59b953f`):
  * The recommender is READ-ONLY: it never edits .env/.env.example/any file and
    never mutates thresholds — it only emits suggested manual edit lines. It
    never recommends LIVE_TRADING_ENABLED=true (guarded + filtered).
  * MOST recommended env vars are NOT yet consumed by the bot (config.js has
    MAX_*_USD + CLI caps, not MAX_*_PCT / MAX_OPEN_POSITIONS / PAPER_* flags). So
    a recommendation usually means "introduce this variable" and shows
    current="(not set)" — honest, but wiring those knobs into config/risk is a
    separate task. MAX_TRADES_PER_DAY and LIVE_TRADING_ENABLED are the only ones
    currently sourced from config.
  * Realized P&L is null today (no exit/mark logic), so win/loss-driven
    recommendations only fire once trades carry pnl_usd; until then the
    recommender is driven mainly by rejection patterns and order frequency.
  * Recommendations are intentionally coarse heuristics (templated), not a
    statistical model; the larger learning/strategy-settings engine is deferred.
- LEARNING/STRATEGY/RESEARCH SLICE LIMITS (committed `385ba4c`):
  * Strategy settings are NON-SECRET only. The updater writes ONLY
    data/strategy-settings.json (gitignored) and ONLY with --write; it NEVER
    writes .env/.env.example, never stores secrets, never enables live trading.
    validateStrategySettings drops any secret-like / LIVE_TRADING_ENABLED key.
  * Notes are appended with de-dup + a hard cap (NOTES_CAP=50) so the file stays
    small over many updates. Bounded deltas: notional/risk ±25%, counts ±20%,
    thresholds ±0.05; floors enforced; never unlimited.
  * The strategy settings are NOT yet consumed by the trading scripts (the loop/
    one-shot still take CLI flags). Wiring loadStrategySettings into the
    loop/once defaults is a deliberate next step, kept separate so a settings
    file can't silently change live behavior before review.
  * RESEARCH is SELECTION-ONLY: no source is fetch_allowed, the selector and
    scripts make NO network calls, and isAllowedUrl rejects any non-allow-listed
    URL. Disabled/paywalled/auth-required sources are never selected. There is NO
    scraping/fetch/robots-bypass anywhere; actual fetching is a future, separately
    reviewed step (injected/fake-HTTP-tested) gated on a source marked
    fetch_allowed AND an explicit CLI flag.
  * Research example feeds are illustrative (e.g. IR RSS base_urls are blank in
    the template); a real run needs the operator to fill in approved feed URLs.

## Next Recommended Task
Committed so far (NOT pushed): one-shot paper slice (`df1931f`), Discord/EOD
slice (`0bb590c`), advanced PAPER slice (`b3387d5`) — all 406/406 green, offline.

EOD constraint-change recommendations are COMMITTED (`59b953f`).

The FULL learning/strategy + research system is COMMITTED (`385ba4c`). Try it:
  node --env-file=.env scripts/updateStrategySettingsFromLearning.js --limit 100
  node --env-file=.env scripts/updateStrategySettingsFromLearning.js --limit 100 --write
  node --env-file=.env scripts/selectResearchTargetsOnce.js --symbols AAPL,MSFT,NVDA --limit 10

Local commits through `385ba4c` are NOT pushed yet; push when ready.

NEXT candidate slices (each separate/reviewed): (1) WIRE
loadStrategySettings into the loop/one-shot defaults so the settings file
actually drives behavior (kept separate so a file edit can't silently change
trading before review); (2) wire the recommended PCT/PAPER_* .env knobs into
config/risk so EOD .env recommendations target consumed values; (3) a real
learning-log table (additive migration 004); (4) a future, fake-HTTP-tested
research FETCH path gated on fetch_allowed + an explicit CLI flag; (5) the
OPENAI_MODEL/provider question.

Verify the committed slices live (paper account) carefully:
  1) DRY RUN advanced (no orders, safe any time):
     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT,NVDA \
       --classifier real_model --allow-shorts --allow-options --options-mode plan_only \
       --max-order-notional 500
  2) DRY RUN the loop (no orders): same flags via scripts/runPaperTradingLoop.js
     --interval-minutes 15 --max-iterations 20
  3) only when intended, during market hours: add --execute-paper (and for options
     --options-mode execute_paper --option-symbol <OCC>).
Then verify Discord live: put DISCORD_WEBHOOK_URL in .env, run
`node --env-file=.env scripts/smokeDiscordWebhook.js`.

REMAINING DEFERRED slices (each its own reviewed task): the FULL learning/strategy
system (runtime data/strategy-settings.json + learning engine + research-source
allow-list + scrape-target selector), a learning-log table (additive migration
004) + reviewPaperLearningOnce, options contract discovery + sell-to-close, and
the OPENAI_MODEL/provider question. NOTE: most env knobs the EOD recommender
references (MAX_*_PCT, MAX_OPEN_POSITIONS, PAPER_* flags) are NOT yet wired into
config.js (which has MAX_*_USD + CLI caps); the recommender suggests them as
manual edits and marks unset/not-yet-wired ones honestly.

Exercise the committed slices meanwhile:
  1) populate a real-model score (during/after market hours):
     node --env-file=.env scripts/runMvpPipelineOnce.js --classifier real_model \
       --symbols AAPL --ingest-limit 5 --classify-limit 1 --measure-limit 1
  2) DRY RUN the paper path (no order, safe any time):
     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL
  3) only during US market hours, and only when you intend to, EXECUTE a paper
     order:
     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL --execute-paper

REMAINING STACKED PHASES (each a separate reviewed slice, in rough order):
  - market-hours PAPER loop (scripts/runPaperTradingLoop.js +
    src/paper/marketHours.js) — dry-run default, RTH/weekend gating, interval +
    max-iteration caps, sanitized heartbeats, graceful shutdown;
  - advanced equities long/short + margin-aware risk (account-capabilities
    client, paperRisk, --allow-shorts) — reverses long-only;
  - paper OPTIONS support (contract discovery or explicit OCC --option-symbol,
    plan_only default) — biggest risk;
  - learning log (additive migration 004) + reviewPaperLearningOnce;
  - strategy-settings file (config/strategy-settings + data/strategy-settings.json,
    bot never edits .env) + updater.
  NOTE: a later prompt requested wiring an `OPENAI_MODEL` env var into the
  classifier, but the real classifier is ANTHROPIC (config.model.classifierModel
  / MODEL_CLASSIFIER_MODEL, default claude-opus-4-8). Wiring an OpenAI model id
  into the Anthropic call is incoherent and was DEFERRED pending clarification
  (rename the existing model env var vs. add a real OpenAI provider).

Separately, the measurement track remains open (lower priority now that paper
trading is the focus). The MVP pipeline TARGETS FRESH events for measurement
(`5afd67f`), so a market-hours pipeline run measures the event it just
ingested/scored instead of defaulting back to event 1. Combined with the measurement-candidate finder
(`a152a66`), the research-summary readiness counts, and the new window
diagnostics + `--baseline-lookback-minutes` flag (`67e745f`), the path to the
first measured rows is now repeatable AND debuggable (the diagnostics show the
exact window and trade count behind each no_baseline). All of this is still NOT
YET RUN against the live feed during market hours.

Recommended next step: during US market hours, RUN the fixed pipeline to land
the first MARKET-HOURS measured rows so real model scores and real measured
returns finally coexist. Either run the full pipeline (it now measures the fresh
ingested event automatically):
  node --env-file=.env scripts/runMvpPipelineOnce.js --classifier real_model \
    --symbols AAPL --ingest-limit 5 --classify-limit 1 --measure-limit 1
  (look for `measurement target — source: inserted ids` and a non-no_baseline
  status), or target a finder-suggested candidate explicitly:
  node --env-file=.env scripts/runMvpPipelineOnce.js --skip-ingest --measure-ids <id>

Alternatively, use the standalone tools directly. During US market hours:
  1) list good candidates:
     node --env-file=.env scripts/listMeasurementCandidates.js --limit 10
  2) measure a suggested candidate (the finder prints the exact command):
     node --env-file=.env scripts/measureReactionsOnce.js --ids <id>
  3) confirm readiness in the summary (look for a non-zero "event-study ready"):
     node --env-file=.env scripts/reportEventStudySummary.js --limit 10
To also store a real model score on the same fresh event, run the full pipeline
with `--classifier real_model` during market hours:
  node --env-file=.env scripts/runMvpPipelineOnce.js --classifier real_model \
    --symbols AAPL --ingest-limit 5 --classify-limit 1 --measure-limit 1
Outside market hours, horizons will keep landing on no_baseline/no_reaction
(correct failures-as-data) — the finder helps avoid exactly that.

Only after real scores AND market-hours measured returns coexist can edge be
measured — that is the first genuine event-study readout (expectancy sliced by
news_type / direction / score bucket, grouped by prompt_version). The summary's
"event-study ready" count is the gate: while it is 0, no expectancy exists yet.

Optional, low priority: re-run the trades smoke check during market hours to
confirm the price/timestamp mapping on a non-empty window.

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
