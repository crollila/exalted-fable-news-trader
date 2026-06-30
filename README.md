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
node --env-file=.env scripts/classifyNewsOnce.js --classifier openai --limit 1
```

`--classifier` defaults to `manual_baseline`; `openai` constructs the production
model classifier (`src/sentiment/modelClassifier.js`, raw HTTP, zero
dependencies). It reads `OPENAI_API_KEY` and `OPENAI_MODEL` **from central config
only** and fails clearly if either is absent. The model id is not defaulted in
code; set it locally in `.env`. Real scores are stored as `model = <configured
model id>` with `prompt_version = "model_v1"` plus parsed provider metadata.
The key is sent in a request header only - never logged, returned, or persisted;
errors are sanitized/redacted. npm tests inject fake HTTP/model responders and
make zero OpenAI network calls. `--classifier real_model` is a visible
deprecated alias that warns and resolves to OpenAI. Anthropic remains available
only through explicit `--classifier anthropic`.

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
   classifier above (or the OpenAI production classifier via `--classifier
   openai`) -> `sentiment_scores` (default 1, capped at 5),
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
whose ticker is in `--symbols`, excluding events that already have a
`paper_trades` row or a `rejected_trades` row. Use `--event-id N` to deliberately
retest a specific scored event. It then builds a whole-share PAPER equity
proposal (long for direction `up`, short for direction `down` only when shorts
are explicitly gated on). Rejections are written to `rejected_trades` with a
reason; an executed order is written to `paper_trades`.

When `--qty` is absent, PAPER equity proposals use the learned target-sizing
engine described below instead of defaulting to one share. A missing valid
reference price or broker account equity makes learned sizing abstain/reject;
it never falls back to `qty=1`. Passing `--qty N` is an explicit manual override:
it bypasses learned sizing, is labeled in console/report/audit output, and still
goes through the deterministic risk gate. Options are not affected by learned
equity sizing.

Flags: `--symbols A,B` (allow-list), `--qty N` (manual override, hard-capped at 100),
`--event-id N` (target a specific scored event), `--confidence-threshold`,
`--impact-threshold`, `--sentiment-threshold` (each a 0–1 float), and
`--execute-paper` (off by default). Default PAPER signal thresholds are now
confidence `0.55`, impact `0.35`, and sentiment magnitude `0.2` (previously
`0.6`, `0.5`, `0.3`). To populate scored events first, run the MVP pipeline /
`classifyNewsOnce.js` with `--classifier openai`.

Output is sanitized — event id, ticker, model/prompt, numeric scores, proposed
side/qty, the risk decision, and (only if an order was sent) the broker order
id/status. When paper credentials are available, the script also records a
broker-truth/performance snapshot and prints broker-confirmed fills, owned
exposure, broker account return, SPY return, account excess return, and any data-quality
warnings.
It also prints the PAPER equity sizing mode, requested target/quantity, approved
or rejected quantity, manual override status, comparable evidence count, and
data-quality warnings.
Never raw model responses, raw payloads, API keys, auth headers, or request
configs. No scheduling or background jobs; never part of `npm test`. The neutral
`manual_baseline` score always fails the gate, so only real-model signals can
ever propose a trade. With the
advanced flags below it also proposes **shorts** (direction down) and **options**.

## Advanced PAPER trading (long/short + options + margin)

> **PAPER ONLY.** Shorts, options, and margin sizing all run against the Alpaca
> **paper** account only. Live trading stays disabled and unsupported; the order
> client is hard-wired to `paper-api.alpaca.markets`.

The one-shot script also supports short equities (`--allow-shorts`, model
direction **down**) and validated single-leg long option plans (`--allow-options`,
long calls for bullish signals and long puts for bearish signals). A CLI flag
alone never enables these paths: `PAPER_ENABLE_SHORTS`,
`PAPER_ENABLE_OPTIONS`, and `PAPER_ENABLE_MARGIN` must be enabled locally, and
broker account/asset/contract/quote checks still have to pass. Orders still
require `--execute-paper`.

Advanced dry-run (no orders):

```
node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT,NVDA --classifier openai --qty 1 --allow-shorts --allow-options --options-mode plan_only --max-order-notional 500
```

Advanced paper execution (sends PAPER equity orders):

```
node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT,NVDA --classifier openai --qty 1 --allow-shorts --allow-options --options-mode plan_only --max-order-notional 500 --execute-paper
```

Risk caps (all conservative by default): `--max-order-notional`,
`--max-symbol-exposure`, `--max-gross-exposure`, `--max-daily-paper-orders`,
`--max-daily-paper-notional`, `--option-max-premium`. Option controls:
`--option-symbol` (optional OCC override), `--option-contract-limit`,
`--option-expiry-days-min/-max`. Margin-aware risk rejects blocked accounts,
shorts without broker-confirmed margin/equity eligibility, insufficient buying
power, and any cap breach (each logged to `rejected_trades` with a reason).
**Monitored PAPER option execution is enabled (long calls/puts only).** Options
require broker contract discovery/tradability and quote validation. With
`PAPER_ENABLE_OPTIONS=true`, `--allow-options --options-mode execute_paper`,
`--execute-paper`, a broker options-eligible account, and a valid regular session,
the bot enters a long call (bullish) or long put (bearish) as a bounded
`buy`/`limit`/`day` order (never a market order), persists a `pending_entry`
audit row, and the loop's **option monitor** reconciles it on each open-market
cycle: it confirms fills, cancels stale unfilled entries after a timeout, and
applies deterministic exits — **take-profit, stop-loss, max-hold, and a mandatory
same-day flatten before the close** — by submitting `sell`/`limit`/`day`
sell-to-close orders (requoted/retried within a bounded window). Exit thresholds
and timing are configurable in `.env` (`PAPER_OPTION_*`, conservative defaults);
no new entries are taken within the pre-close cutoff. The monitor only manages
positions the bot recorded itself (never manual/untracked positions), and any
unresolved/unflattened position is reported **loudly** in console output and the
Discord EOD report. Out of scope and never done: selling options to open, naked
options, covered calls, spreads, assignment/exercise, and multi-leg strategies.
All order submission remains hard-wired to the Alpaca paper endpoint.

## Broker truth and SPY benchmark reporting

The PAPER runtime now has a reconciliation/performance layer that is still
read-only with respect to broker state: it never submits or cancels orders. It
polls only Alpaca PAPER order ids already recorded by ExaltedFable:

- equity rows in `paper_trades` with `broker_order_id`, plus legacy rows whose
  `trade_reason` contains the existing `paper order <id>` marker;
- option rows in `paper_option_trades` with recorded entry/exit order ids.

Manual Alpaca account activity is not considered ExaltedFable-owned strategy
exposure. Broker-wide account snapshots are stored and labeled separately from
owned exposure. Current owned gross exposure and open-position count require a
current positions snapshot; if positions are unavailable, exposure is reported
as `unavailable` rather than inferred from old fills.

Each reconciliation can persist broker order status, filled quantity, average
fill price, fill/submission/update timestamps, coarse open/closed/canceled
state, PAPER account equity/portfolio-value snapshots, broker account return,
ExaltedFable-owned exposure, broker-confirmed realized P&L when available, and
data-quality warnings. Supported broker states include pending, partially
filled, filled, canceled, rejected, expired, replaced, and unknown.

SPY benchmark prices are captured through the existing `PriceSource`
abstraction, not a new provider path. For the strategy baseline and each later
snapshot, the system asks for SPY trades in a lookback window ending exactly at
the account snapshot timestamp and uses the latest trade at or before that
timestamp. If either aligned SPY price is missing, SPY return and excess return
are reported as `unavailable`.

## Learned PAPER equity target sizing

PAPER equity entries now use an explainable target portfolio-weight decision
when `--qty` is not explicitly supplied. The sizing engine is pure and
testable: it reads only injected signal metadata, broker-confirmed
ExaltedFable-owned historical outcomes, current bot-owned exposure, broker
account capacity, configured caps, and the already-approved PriceSource
reference price. It never calls a model/provider, never fetches a new data
source, never edits strategy files, and never changes risk caps.

Sizing modes are:

- `cold_start` - conservative exploration when no sufficient comparable
  broker-confirmed outcomes exist;
- `evidence_weighted` - a shrunken, positive-expectancy adjustment only after
  enough independent comparable outcomes exist for the same model/prompt
  version;
- `abstain` - used when price, equity, ownership, fill/P&L truth, duplicate
  status, or comparable evidence quality is insufficient.

Comparable outcomes are considered in a transparent hierarchy: exact
ticker/news-type/direction/score bucket, then news-type/direction/score bucket,
then direction/score bucket. Evidence never mixes model/prompt versions, never
uses broker-wide account returns, excludes manual `--qty` override trades once
they are audited, and uses legacy rows only when their score provenance is
unambiguous. Sparse wins are shrunk toward neutral; losing or uncertain
comparable records reduce allocation or cause abstention.

Non-secret controls live in `config/strategy-settings.example.json` and optional
local `data/strategy-settings.json`: `sizing_min_comparable_sample_size`,
`sizing_cold_start_target_weight`, `sizing_max_target_weight`,
`sizing_enable_confidence_scaling`, and `sizing_enable_impact_scaling`.
Defaults are conservative (`10` samples, `0.75%` cold-start target, `1%` learned
target ceiling) and remain beneath the existing hard order/exposure/notional
caps. The sizing engine requests a whole-share quantity; `paperRisk` remains
authoritative for account, buying-power, exposure, daily notional/order, and
short/margin vetoes.

Every equity sizing decision is recorded in
`paper_equity_sizing_decisions` with sanitized requested and approved/rejected
weight/notional/quantity, sizing mode, evidence count/quality, clamp/rejection
reason, manual override flag, and warnings. It never stores raw model responses,
headlines, secrets, or request objects. Console and EOD reports summarize these
decisions separately from broker-truth account performance.

## Market-hours PAPER loop

The loop runs continuously by default until Ctrl+C and performs a fresh decision
cycle only during a valid US regular equity session. It prefers Alpaca
clock/calendar state, including holidays and early closes, and falls back to an
explicit local Mon-Fri regular-hours approximation only when the clock is
unavailable. Outside a valid session it performs only the minimal market-clock
check, prints the next wake time, and sleeps; it does not call OpenAI, news,
price, option-contract, option-quote, or order endpoints while closed.

Each open-market iteration ranks the configured base universe, ingests recent
Alpaca news for the selected capped symbols, classifies newly inserted events
when `--classifier openai` is requested, selects a fresh unprocessed `model_v1`
score, and then reuses the one-shot PAPER proposal/risk/order path. It is
**dry-run by default**, enforces a **>= 5-minute** interval, prints sanitized
state transitions, cycle outcomes, and broker-truth/performance snapshots when
paper credentials are available, sends one idempotent EOD report per completed
session when requested, and exits cleanly on Ctrl+C. `--max-iterations` exists
only as an explicit debug/test cap.

Loop dry-run:

```
node --env-file=.env scripts/runPaperTradingLoop.js --symbols AAPL,MSFT,NVDA --classifier openai --qty 1 --allow-shorts --allow-options --options-mode plan_only --interval-minutes 15 --max-order-notional 500
```

Loop paper execution (with an end-of-day Discord report):

```
node --env-file=.env scripts/runPaperTradingLoop.js --symbols AAPL,MSFT,NVDA --classifier openai --qty 1 --allow-shorts --allow-options --options-mode plan_only --interval-minutes 15 --max-order-notional 500 --execute-paper --send-discord-eod-report
```

Extra loop flags: `--interval-minutes` (floored at 5), `--max-iterations N`
(explicit debug/test cap), `--ingest-limit` (default 20, capped at 50),
`--classify-limit` (default/cap 5), `--max-symbols-per-cycle` (cost cap),
`--news-lookback-minutes` (default 60, capped at 390), and
`--send-discord-eod-report` (posts the idempotent EOD summary after a completed
session if `DISCORD_WEBHOOK_URL` is set). `--run-outside-market-hours` is
deprecated and ignored. Heartbeats distinguish `no_new_news`,
`no_fresh_real_model_score`, `all_fresh_scores_failed_signal_thresholds`,
`already_processed_event`, `risk_rejection`, and `broker_submission_error`.
Never part of `npm test` (the loop core runs with injected clock/sleep/
market-hours/fakes — no real timers, no network).

## Discord end-of-day reports

The bot can post a sanitized end-of-day PAPER summary to a Discord channel.

**Create a webhook (one time):** in Discord, open **Server Settings →
Integrations → Webhooks → New Webhook**, pick the channel, and **Copy Webhook
URL**. That URL is a **secret** (it embeds a token) — paste it into your local
`.env` only; never commit it. Add to `.env` (see `.env.example`):

```
DISCORD_WEBHOOK_URL=<your Discord webhook URL>
DISCORD_SERVER_ID=<optional server id>
DISCORD_CHANNEL_ID=<optional channel id>
```

`DISCORD_SERVER_ID` / `DISCORD_CHANNEL_ID` are optional metadata (printed for a
sanity check); they **cannot** post on their own — only `DISCORD_WEBHOOK_URL`
sends.

**Test the EOD Discord delivery path** (posts one small sanitized test message):

```
node --env-file=.env scripts/sendPaperEodReport.js --test-message
```

It prints the configured server/channel ids, whether a webhook is configured,
and the send result — **never** the webhook URL. A Discord delivery failure is
recorded as a non-fatal report status and does not stop PAPER trading cycles.

**Preview the end-of-day report locally (sends nothing, no webhook needed):**

```
node --env-file=.env scripts/sendPaperEodReport.js --dry-run
node --env-file=.env scripts/sendPaperEodReport.js --dry-run --session-id <paper_runtime_sessions id>
```

**Send the end-of-day report to Discord (requires the webhook):**

```
node --env-file=.env scripts/sendPaperEodReport.js --send-discord
```

The report summarizes one completed runtime session when `--session-id` is
provided, or the requested trading day (`--day YYYY-MM-DD`, default today UTC):
cycles, fresh news, classification outcomes, skipped/rejected reason counts,
local order/rejection evidence, broker-confirmed submitted-vs-filled counts,
open/canceled/rejected/expired broker status counts, ExaltedFable-owned
exposure, broker-confirmed owned P&L when available, broker-wide PAPER account
return, aligned SPY return, account excess return versus SPY, shorts/options/
margin usage, data-quality warnings, and advisory-only next-session
observations. Output is
sanitized — counts, tickers, sides, statuses, our own rejection reasons, and
rounded P&L only; never raw model responses, raw payloads, headlines, API keys,
headers, raw request URLs, or the webhook URL. **Dry run is the default**; an
actual send happens only with `--send-discord` (or `--test-message`), and
missing the webhook fails clearly when a send is requested. Never part of
`npm test` (tests use fake HTTP only).

> Non-secret strategy parameters live in a separate settings file, **not** in
> `.env` — the bot never edits `.env`. Live trading remains disabled.

### Recommended manual `.env` changes

The EOD report ends with a **“Recommended manual .env changes”** section. The bot
analyzes the current session's `paper_trades` / `rejected_trades` plus persisted
runtime/research records and, **only when data quality and sample size are
sufficient**, suggests conservative, bounded edits to your risk constraints —
for example:

```
— Recommended manual .env changes —
  • MAX_TRADE_NOTIONAL_PCT: decrease  (current 0.01 -> 0.0075)  [recommended, confidence medium]
      reason: Net realized P&L was negative (-120) with 2 losing vs 1 winning trade(s); reduce per-trade notional until win rate improves.
      evidence: wins=1 losses=2 orders=3 rejections=0
      edit:   MAX_TRADE_NOTIONAL_PCT=0.0075
  The bot did not edit .env. These are recommendations only.
```

If nothing is warranted, if there are fewer than 10 unique qualifying events, or
if duplicate/stale-event replay contaminates the evidence window, it prints
**“No manual .env constraint changes recommended today.”** Key guarantees:

- **The bot NEVER edits `.env` or `.env.example`.** It only prints/sends the
  exact line you could change by hand; you review and edit it yourself.
- Changes are **bounded** (percentages ±25%, count limits ±20%, thresholds ±0.05
  per day) and **conservative** — it lowers risk readily after losses, repeated
  rejections, drawdowns, or excessive order frequency, and only suggests a small
  bounded *increase* after strong positive evidence over enough trades.
- It **never recommends enabling live trading**. If `LIVE_TRADING_ENABLED` ever
  appears it is only ever recommended to stay `false`.
- Recommendable knobs include `MAX_POSITION_PCT`, `MAX_TRADE_NOTIONAL_PCT`,
  `MAX_DAILY_LOSS_PCT`, `MAX_TOTAL_EXPOSURE_PCT`, `MAX_TRADES_PER_DAY`,
  `MAX_OPEN_POSITIONS`, and paper flags (`PAPER_ENABLE_SHORTS`,
  `PAPER_ENABLE_OPTIONS`, `PAPER_ENABLE_MARGIN`,
  `PAPER_CONFIDENCE_THRESHOLD`, `PAPER_IMPACT_THRESHOLD`,
  `PAPER_SENTIMENT_THRESHOLD`, ...). Recommendations record the evidence window,
  sample size, data-quality status, old->new proposal, rationale, confidence,
  and limitations in `paper_recommendation_audits`; they never change `.env`,
  prompts, active limits, database settings, or runtime behavior automatically.

The same section is included in the Discord message (sanitized; truncated to
Discord's length limit). Suppress it with `--no-constraint-recommendations`.

## Strategy settings & learning

Non-secret strategy parameters live in a JSON **settings file**, never in `.env`:

- `config/strategy-settings.example.json` — committed template/defaults.
- `data/strategy-settings.json` — local runtime override (**gitignored**;
  created only when you run the learning updater with `--write`).

Settings include `symbols`, `allow_shorts`, `allow_options`, `options_mode`,
`max_order_notional`, `max_*_exposure`, `max_daily_paper_*`, `max_option_premium`,
the `*_threshold` knobs, learned equity sizing controls
(`sizing_min_comparable_sample_size`, `sizing_cold_start_target_weight`,
`sizing_max_target_weight`, and optional confidence/impact scaling),
`interval_minutes`, an optional debug `max_iterations`, and research
focus (`scrape_target_groups`, `scrape_symbol_focus`). All values are
validated/capped on load; secrets and `LIVE_TRADING_ENABLED` are never accepted.
When `data/strategy-settings.json` exists, the PAPER one-shot/loop use these
non-secret values as defaults; explicit CLI flags still override them, and the
settings file can never enable `--execute-paper`.

The **learning updater** reads recent paper outcomes and recommends conservative,
bounded changes to the settings file (notional ±25%, counts ±20%, thresholds
±0.05). It is **dry-run by default**:

```
node --env-file=.env scripts/updateStrategySettingsFromLearning.js --limit 100
```

Only with `--write` does it write — and **only** `data/strategy-settings.json`
(never `.env`, never secrets). Notes are **appended** (de-duplicated + capped) so
the file does not bloat:

```
node --env-file=.env scripts/updateStrategySettingsFromLearning.js --limit 100 --write
```

Other flags: `--settings-path`, `--min-sample-size`, `--include-env-recommendations`
(also lists manual `.env` suggestions), `--format text|json`. The EOD report also
shows an advisory "Strategy setting recommendations" section + a next-day
research-focus plan when sample/data-quality rules pass.

> The bot **never edits `.env`**, **never changes active runtime constraints from
> the EOD report**, and **never enables live trading**. The standalone learning
> updater writes only the non-secret strategy file, and only when you pass
> `--write`.

## Research source selection (allow-list, selection-only)

The bot chooses what to research next from an **approved allow-list** —
`config/research-sources.example.json` — never arbitrary URLs. This patch is
**selection-only**: it ranks/selects approved sources but performs **no network
calls and never scrapes/fetches**. Disabled, paywalled, login/auth-required, and
`scrape_mode: disabled` sources are never selected.

```
node --env-file=.env scripts/selectResearchTargetsOnce.js --symbols AAPL,MSFT,NVDA --limit 10
node --env-file=.env scripts/selectResearchTargetsOnce.js --symbols AAPL,MSFT,NVDA --limit 10 --format json
```

Output is a sanitized **plan** (source id, type, `scrape_mode`, symbol/topic
focus, rate-limit note, and `fetch=disabled`) plus topic hints derived from the
day's trading. `--fetch` is **not honored** (selection-only); fetching would
require a source explicitly marked `fetch_allowed` and a future, separately
reviewed change with injected/fake-HTTP-tested transport. No paywalls, logins,
robots.txt, or rate limits are ever bypassed.

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
