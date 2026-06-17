# ExaltedFable

AI news event-study and Alpaca paper-trading research system.

## Goal

ExaltedFable is a clean V2 of an older AI news trading bot. The purpose is not to assume the strategy works. The purpose is to measure whether AI-scored news events have tradeable edge.

## Core idea

1. Collect market news from pluggable providers.
2. Classify and score each event with an AI model.
3. Measure the stock reaction after 10s, 1m, 5m, 30m, 1h, and EOD.
4. Paper trade only when risk rules allow.
5. Compare theoretical entries to actual Alpaca paper fills.
6. Report expectancy by news type, score bucket, provider, ticker, liquidity, and time of day.

## Safety

- Paper trading only by default.
- Live trading disabled by default.
- Never commit API keys.
- All important actions should be logged.

## Manual smoke checks

The only live-network touchpoint is a manual diagnostic script. It is never
part of `npm test`, never scheduled, and prints sanitized metadata only
(never keys, headers, request URLs, or raw payloads):

```
node --env-file=.env scripts/smokeAlpacaNews.js --symbols AAPL --limit 5
```

Requires `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` in your local,
uncommitted `.env` (see `.env.example`). The script fails clearly when they
are missing.

## Manual one-shot ingest

Once the smoke check passes, a second manual-only script persists a tiny
capped sample (limit hard-capped at 10) of real Alpaca news into the
`news_events` table, through the existing provider → ingestion →
persistence path (same dedup, same normalization — no separate code path):

```
node --env-file=.env scripts/ingestAlpacaNewsOnce.js --symbols AAPL --limit 5
```

It writes to the SQLite file configured by `DATABASE_URL` (default
`data/exalted_fable.sqlite`, git-ignored), running migrations first if
needed. One fetch, one batch of inserts, then exit: never part of
`npm test`, no polling, no scheduling, no sentiment/model calls, no
market-data calls, no trading. Output is a sanitized summary only
(provider, counts, inserted row ids, truncated per-event errors) — never
keys, headers, request objects, or raw payloads. Same credential
requirements as the smoke check; fails clearly when unconfigured.

## Manual trades smoke check

A third manual-only script confirms the real Alpaca Trades PriceSource can
reach the market-data API and normalize trades for one ticker over one tiny
recent window. It uses the same Alpaca key pair (account-level) read via
config only:

```
node --env-file=.env scripts/smokeAlpacaTrades.js --symbol AAPL --minutes 5 --lag 20
```

The window ends `--lag` minutes in the past (default 20, minimum 16) to stay
outside Alpaca's too-recent-data restriction on the free IEX feed, and spans
`--minutes` (default 5, capped at 60). Output is sanitized metadata only —
symbol, requested window, source name, trade count, first/last trade
timestamps, and min/max price (public market data) — never keys, headers,
request URLs, or raw payloads. Zero trades is still a PASS: outside market
hours or on the thin IEX feed an empty window is expected, and the check
proves reachability and normalization, not feed completeness. Never part of
`npm test`, no polling, no scheduling, no database writes, no trading, no
model calls. Same credential requirements as the news scripts; fails clearly
when unconfigured.

## Manual capped measurement

A fourth manual-only script measures real price reactions for a tiny capped
set of **existing** `news_events` rows. It explicitly constructs the real
Alpaca Trades PriceSource and runs the existing measurement engine, writing
`price_reactions` rows only through the existing `insertPriceReaction` path
(re-measurement replaces, never duplicates):

```
node --env-file=.env scripts/measureReactionsOnce.js --limit 1
node --env-file=.env scripts/measureReactionsOnce.js --ids 1,2,3
```

`--limit` defaults to 1 and is hard-capped at 5 events; `--ids` selects
specific event ids (also capped at 5). Only events that have both a ticker
and a `received_at` are eligible. Output is a sanitized summary only —
selected/measured/failed event counts, `measurement_status` counts, horizons
attempted, the source name, and a compact per-event line (id, ticker,
per-horizon status). Never keys, headers, request URLs, raw trade payloads, or
raw news payloads. Some horizons landing on `no_baseline`/`no_reaction` is the
expected, correct outcome for events received outside market hours — failures
are stored as data. Never part of `npm test`, no polling, no scheduling, no
trading, no model calls. Same credential requirements as the news scripts;
fails clearly when unconfigured.

## Manual measurement candidate finder

Measured returns only appear when an event's window overlaps real trading, so
picking events blindly tends to produce all-`no_baseline` rows. This read-only
helper ranks **existing** `news_events` by how likely a measurement is to yield
a measured return and prints a ready-to-paste measure command:

```
node --env-file=.env scripts/listMeasurementCandidates.js --limit 10
node --env-file=.env scripts/listMeasurementCandidates.js --ticker AAPL --all
```

It lists only events that have both a ticker and a `received_at`. By default it
keeps **market-hours, not-yet-measured** candidates, ranked best-first; `--all`
lists every eligible event (still ranked best-first), `--ticker` filters to one
symbol, and `--limit` defaults to 10 (hard-capped at 50). Per candidate it
prints event id, ticker, provider, `received_at`, an Eastern-time label, a
market-hours flag, whether a real-model (`model_v1`) score exists, whether it is
already measured, and its `price_reactions` status counts — then the exact
`measureReactionsOnce.js --ids <id>` command, plus a combined command for the
top candidates (capped at 5, the measure script's `--ids` limit).

The market-hours test is an **approximation** (Mon–Fri 09:30–16:00
America/New_York, DST handled automatically); it does **not** model market
holidays or half-days — a real session calendar is deferred to the market-data
client's later session step. It is **read-only** (SELECTs only, no writes, no
migrations), makes no network call, runs no measurement, and needs no
credentials (the `--env-file` only resolves `DATABASE_URL`). Output never prints
headlines, bodies, raw payloads, raw model responses, or keys — safe to paste
into ChatGPT. Never part of `npm test`, no polling, no scheduling, no trading.

## Manual research summary

A manual-only script prints a sanitized, paste-safe snapshot of the
local research database. It is **read-only** — SELECTs only, no writes, no
migrations, and no network or credentials:

```
node --env-file=.env scripts/reportEventStudySummary.js --limit 10
```

It reports total `news_events`, `sentiment_scores`, and `price_reactions`
rows; **event-study readiness counts** (measured rows, real-model `model_v1`
score count, and the number of events that have *both* a `model_v1` score and a
measured reaction — the headline "ready for an expectancy readout" number);
`measurement_status` counts, horizon counts, measured-return averages by
horizon, and a small capped list of recent measured rows (event id, ticker,
horizon, return, timestamp). It never prints headlines, bodies, raw payloads,
raw model responses, keys, or any free-text content — output is safe to paste
into ChatGPT. The `--env-file` is only used to resolve `DATABASE_URL`; no API
keys are needed. Never part of `npm test`, no polling, no scheduling.

## Manual classification / scoring

A sixth manual-only script scores a tiny capped set of **existing**
`news_events` rows using a **deterministic, model-free manual classifier** and
writes `sentiment_scores` through the existing `classifyAndStore` →
`insertSentimentScore` path (no schema change, idempotent reruns):

```
node --env-file=.env scripts/classifyNewsOnce.js --limit 1
node --env-file=.env scripts/classifyNewsOnce.js --ids 1,2,3
```

`--limit` defaults to 1 and is hard-capped at 5; `--ids` selects specific
event ids (also capped at 5). Without `--ids`, only rows not yet scored by this
`(model, prompt_version)` are selected, so reruns pick up fresh events. The
default classifier is **not a model**: it emits a neutral, deterministic
baseline (`sentiment/impact/confidence = 0`, `direction = "unclear"`,
`model = "manual_baseline"`, `prompt_version = "manual_v1"`). It exists to
prove the loop carries a score alongside the price reaction — it is a
placeholder, **not trading signal**. No credentials or network are needed.
Output is a sanitized summary only (selected/classified/stored/skipped/failed
counts, `parser_status` counts, model, prompt version) — never raw news
payloads, raw model responses, keys, or headers. Never part of `npm test`, no
polling, no scheduling, no trading.

### Real model-backed classifier (explicit, opt-in)

The same script can score with a **real model** behind the identical classifier
contract, parser, and storage path. It is explicit and opt-in:

```
node --env-file=.env scripts/classifyNewsOnce.js --classifier real_model --limit 1
```

`--classifier` defaults to `manual_baseline`; `real_model` constructs the
Anthropic Messages API classifier (`src/sentiment/modelClassifier.js`, raw HTTP,
zero dependencies). It reads `ANTHROPIC_API_KEY` **from config only** and fails
with a clear "not configured" error if the key is absent. The model id defaults
to `claude-opus-4-8` and can be overridden with `MODEL_CLASSIFIER_MODEL`. Real
scores are stored as `model = <model id>`, `prompt_version = "model_v1"`. The
key is sent in a request header only — never logged, returned, or persisted; all
errors are sanitized/redacted. The raw model response is preserved byte-for-byte
through the existing `insertSentimentScore` path; malformed / out-of-range /
missing-field / model-error outcomes are stored as data, never silently dropped.
This path is **never exercised by `npm test`** (all tests inject a fake HTTP
client); it makes a live model call only when you run it manually with a real
key. The MVP pipeline accepts the same `--classifier real_model` flag.

## Manual MVP pipeline (end-to-end)

A seventh manual-only script runs the whole capped research loop in one
command:

```
node --env-file=.env scripts/runMvpPipelineOnce.js --symbols AAPL \
  --ingest-limit 5 --classify-limit 1 --measure-limit 1
node --env-file=.env scripts/runMvpPipelineOnce.js --skip-ingest
```

It performs four clearly-reported stages, each through the **existing** paths
only:

1. **ingest** a tiny sample of real Alpaca news → `news_events`
   (default 5, hard-capped at 20; skipped via `--skip-ingest` or when
   credentials are absent),
2. **classify/score** a tiny unscored set with the deterministic manual
   classifier above (or the real model classifier via `--classifier
   real_model`) → `sentiment_scores` (default 1, capped at 5),
3. **measure** price reactions for a tiny set via the real Alpaca Trades
   PriceSource → `price_reactions` (default 1, capped at 5; skipped when
   credentials are absent),
4. **report** a read-only research summary of the local database.

It is **research/measurement only — it never trades, submits orders, or calls
any trading API.** Stages 1 and 3 need Alpaca credentials; when they are
missing (or ingest is skipped) those stages are reported as `SKIPPED` and the
loop still classifies existing events and prints the summary. `no_baseline` /
`no_reaction` outcomes are reported as data, never hidden. Output composes the
existing per-stage sanitized reports — never keys, headers, request URLs, raw
trade payloads, raw news payloads, or raw model responses. Never part of
`npm test`, no polling, no scheduling.

## Old V1 reference

https://github.com/crollila/High-Frequency-Trading-Algorithm-with-Instant-News-Sentiment-Analysis

## Documentation

- [News provider adapters](docs/providers.md) — provider abstraction, canonical event path, injected-transport pattern, and fixture-only safety.
- [Phase 3 sentiment/classification plan](docs/sentiment-classification-plan.md) — taxonomy, scoring output schema, prompt versioning, fallback handling, and testing plan (design only).
- [Sentiment storage plan](docs/sentiment-storage-plan.md) — sentiment_scores writer mapping and the hybrid columns-plus-JSON-detail storage decision (design only).
- [Phase 4 event-study plan](docs/event-study-plan.md) — price reaction measurement design: horizons, anchoring, unavailable-price handling, and the row-per-window decision (design only).
- [Claude task template](docs/claude-task-template.md) — compact reusable prompt for routine Claude/Cowork tasks.
- [Real-data tier plan](docs/real-data-tier-plan.md) — first real-data step decision: provider transport vs market-data client, key safety, and disabled-by-default rules (design only).
- [Market-data client plan](docs/market-data-client-plan.md) — first real PriceSource design: Alpaca trades (IEX feed) behind the existing contract, failure/status mapping, deferred market_closed/EOD policy, and fake-HTTP test plan (design only).
