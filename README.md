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
node --env-file=.env scripts/runMvpPipelineOnce.js --measure-ids 6,7,8
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

The measure stage targets **fresh/current-run events first** so a market-hours
run measures what it just ingested/scored instead of repeatedly re-measuring the
oldest event. It chooses event ids in priority order: (1) explicit
`--measure-ids 6,7,8` (deduped, capped at 5), (2) events the ingest stage just
inserted this run, (3) events the classify stage just scored this run, (4) an
oldest-eligible fallback only when no current-run ids are available. The report
prints which source was used (`measurement target — source: …`). Selection still
flows through the existing capped `selectEvents` helper, so eligibility and the
hard cap are unchanged, and writes still go only through the existing
`measureEvents` → `insertPriceReaction` path.

It is **research/measurement only — it never trades, submits orders, or calls
any trading API.** Stages 1 and 3 need Alpaca credentials; when they are
missing (or ingest is skipped) those stages are reported as `SKIPPED` and the
loop still classifies existing events and prints the summary. `no_baseline` /
`no_reaction` outcomes are reported as data, never hidden. Output composes the
existing per-stage sanitized reports — never keys, headers, request URLs, raw
trade payloads, raw news payloads, or raw model responses. Never part of
`npm test`, no polling, no scheduling.

## Manual PAPER trading (one-shot)

> **PAPER ONLY.** This path submits orders to the Alpaca **paper** endpoint
> only. Live trading is disabled by default and is **not supported** by this
> script or its order client — the endpoint is hard-coded to
> `https://paper-api.alpaca.markets` and nothing here can point at the live API.

An eighth manual-only script turns one **real-model-scored** news event into a
conservative paper-trade proposal, runs a minimal risk gate, and — only when you
explicitly ask — submits a single PAPER market order.

Dry run (the default — prints the proposal/decision, **sends no order**, needs
no trading credentials):

```
node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL
```

Execute a PAPER order (requires Alpaca paper credentials in `.env`):

```
node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL --execute-paper
```

It selects one recent event scored by the real model (`prompt_version=model_v1`)
whose ticker is in `--symbols`, then builds an **equity long, market buy, whole
shares** proposal. The risk gate **rejects** unless: the ticker is in the
`--symbols` allow-list, the parser status is `parsed`/`fallback_used`, the model
direction is `up` (long-only — **no shorts**), and confidence/impact/sentiment
clear conservative thresholds. Rejections are written to `rejected_trades` with a
reason; an executed order is written to `paper_trades`. An accepted **dry run**
writes nothing and stops before any order.

Flags: `--symbols A,B` (allow-list), `--qty N` (default 1, hard-capped at 100),
`--event-id N` (target a specific scored event), `--confidence-threshold`,
`--impact-threshold`, `--sentiment-threshold` (each a 0–1 float), and
`--execute-paper` (off by default). To populate scored events first, run the MVP
pipeline / `classifyNewsOnce.js` with `--classifier real_model`.

Output is sanitized — event id, ticker, model/prompt, numeric scores, proposed
side/qty, the risk decision, and (only if an order was sent) the order id/status.
Never raw model responses, raw payloads, API keys, auth headers, or request
configs. No options, no shorts, no margin logic, no scheduling, no background
jobs; never part of `npm test`. The neutral `manual_baseline` score always fails
the gate, so only real-model `up` signals can ever propose a trade. With the
advanced flags below it also proposes **shorts** (direction down) and **options**.

## Advanced PAPER trading (long/short + options + margin)

> **PAPER ONLY.** Shorts, options, and margin sizing all run against the Alpaca
> **paper** account only. Live trading stays disabled and unsupported; the order
> client is hard-wired to `paper-api.alpaca.markets`.

The one-shot script also supports short equities (`--allow-shorts`, on a
margin/short-eligible paper account, model direction **down**), single-leg long
options by explicit OCC symbol (`--allow-options --option-symbol …`), and
margin-aware risk caps. Orders still require `--execute-paper`; options additionally
require `--options-mode execute_paper` **and** a verified account options capability.

Advanced dry-run (no orders):

```
node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT,NVDA --classifier real_model --qty 1 --allow-shorts --allow-options --options-mode plan_only --max-order-notional 500
```

Advanced paper execution (sends PAPER orders):

```
node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT,NVDA --classifier real_model --qty 1 --allow-shorts --allow-options --options-mode execute_paper --option-symbol <OCC_OPTION_SYMBOL> --max-order-notional 500 --execute-paper
```

Risk caps (all conservative by default): `--max-order-notional`,
`--max-symbol-exposure`, `--max-gross-exposure`, `--max-daily-paper-orders`,
`--max-daily-paper-notional`, `--option-max-premium`. Option controls:
`--option-symbol` (OCC, **required to execute** — there is no contract discovery
in this patch), `--option-contract-limit`, `--option-expiry-days-min/-max`.
Margin-aware risk rejects blocked accounts, shorts without margin/equity
eligibility, insufficient buying power, and any cap breach (each logged to
`rejected_trades` with a reason). Options without a quote feed cannot pre-verify
premium — exposure is bounded by `--option-contract-limit` (paper-only).

## Market-hours PAPER loop

A bounded loop runs the one-shot path on an interval during the US regular
session only (Mon–Fri 09:30–16:00 ET; weekends skipped). It is **dry-run by
default**, reuses the one-shot logic, enforces a **≥ 5-minute** interval and a
max-iteration cap, prints a sanitized heartbeat each iteration, and exits
cleanly on Ctrl+C. **Holiday limitation:** US market holidays/half-days are
**not** modeled (no exchange calendar yet) — printed at startup.

Loop dry-run:

```
node --env-file=.env scripts/runPaperTradingLoop.js --symbols AAPL,MSFT,NVDA --classifier real_model --qty 1 --allow-shorts --allow-options --options-mode plan_only --interval-minutes 15 --max-iterations 20 --max-order-notional 500
```

Loop paper execution (with an end-of-day Discord report):

```
node --env-file=.env scripts/runPaperTradingLoop.js --symbols AAPL,MSFT,NVDA --classifier real_model --qty 1 --allow-shorts --allow-options --options-mode execute_paper --option-symbol <OCC_OPTION_SYMBOL> --interval-minutes 15 --max-iterations 20 --max-order-notional 500 --execute-paper --send-discord-eod-report
```

Extra loop flags: `--interval-minutes` (floored at 5), `--max-iterations`
(capped), `--run-outside-market-hours true|false` (default false),
`--send-discord-eod-report` (posts the EOD summary when the loop ends, if
`DISCORD_WEBHOOK_URL` is set). Never part of `npm test` (the loop core runs with
injected clock/sleep/market-hours/one-shot — no real timers, no network).

## Discord end-of-day reports

The bot can post a sanitized end-of-day PAPER summary to a Discord channel.

**Create a webhook (one time):** in Discord, open **Server Settings →
Integrations → Webhooks → New Webhook**, pick the channel, and **Copy Webhook
URL**. That URL is a **secret** (it embeds a token) — paste it into your local
`.env` only; never commit it. Add to `.env` (see `.env.example`):

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/.../...
DISCORD_SERVER_ID=1515469212213317823
DISCORD_CHANNEL_ID=1517321598456299610
```

`DISCORD_SERVER_ID` / `DISCORD_CHANNEL_ID` are optional metadata (printed for a
sanity check); they **cannot** post on their own — only `DISCORD_WEBHOOK_URL`
sends.

**Test the connection** (posts one small test message to the channel):

```
node --env-file=.env scripts/smokeDiscordWebhook.js
```

It prints the configured server/channel ids, whether a webhook is configured,
and the send result — **never** the webhook URL.

**Preview the end-of-day report locally (sends nothing, no webhook needed):**

```
node --env-file=.env scripts/sendPaperEodReport.js --dry-run
```

**Send the end-of-day report to Discord (requires the webhook):**

```
node --env-file=.env scripts/sendPaperEodReport.js --send-discord
```

The report summarizes the local `paper_trades` / `rejected_trades` for the
trading day (`--day YYYY-MM-DD`, default today UTC): proposals, orders submitted,
fills, long/short counts, rejections and their reasons, approximate realized
P&L, plus a short **what it did / why / what went well / what went poorly /
mistakes & lessons / next-day ideas** narrative. With no records yet it prints a
safe placeholder that still proves delivery. Output is sanitized — counts,
tickers, sides, statuses, our own rejection reasons, and rounded P&L only; never
raw model responses, raw payloads, headlines, API keys, headers, or the webhook
URL. **Dry run is the default**; an actual send happens only with
`--send-discord` (or `--test-message`), and missing the webhook fails clearly
when a send is requested. Never part of `npm test` (tests use fake HTTP only).

> Strategy parameters will live in a separate settings file (planned), **not**
> in `.env` — the bot never edits `.env`. Live trading remains disabled.

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
