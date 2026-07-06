# ExaltedFable

An AI news event-study and Alpaca **paper-trading** research system: ingest
market news, score it with an LLM, paper-trade the affected stocks under hard
risk caps, measure every outcome, and learn from the results — so the system
can eventually prove (or disprove) that AI-scored news events have trading
edge.

ExaltedFable is the V2 rebuild of
[the V1 news-sentiment bot](https://github.com/crollila/High-Frequency-Trading-Algorithm-with-Instant-News-Sentiment-Analysis),
with the measurement, risk, and learning discipline V1 lacked.

## Safety (non-negotiable)

- **PAPER ONLY.** The order client is hard-wired to
  `https://paper-api.alpaca.markets`; there is no live endpoint anywhere in
  the codebase and no config/env override for it. `LIVE_TRADING_ENABLED=false`
  is the default and nothing consumes it for order routing.
- **DRY RUN IS THE DEFAULT.** Real paper orders go out only with
  `--execute-paper` and configured Alpaca keys.
- **Hard risk rails:** per-order notional, per-symbol and gross exposure,
  daily order-count and notional caps, and a **daily-loss kill switch** that
  halts all new trades for the rest of the UTC day when the day's
  broker-confirmed realized loss breaches the cap. The cap is
  percent-of-equity (`MAX_DAILY_LOSS_PCT`, default 1% — $10,000/day on a $1M
  paper account) with `MAX_DAILY_LOSS_USD` as the fixed fallback when equity
  is unknown. Every refused trade is logged to `rejected_trades` with the
  reason.
- **Managed exits:** every cycle checks open positions BEFORE new entries and
  closes them on stop-loss, take-profit, or a max-hold clock. The stop and
  target **adapt as the system learns** — re-derived each cycle from
  broker-confirmed win/loss sizes, hard-clamped to rails so learning can tune
  the protection but never remove it.
- **Sanitized output only.** No raw model responses, provider payloads, API
  keys, or webhook URLs in logs or reports. The bot never writes `.env`.

## The pipeline

```
exit monitor (close open positions first: learned stop-loss / take-profit / max-hold)
  ← runs at the start of every cycle, before any new entry
news (Alpaca / Benzinga plug-in)
  → news_events (SQLite, deduped)
  → LLM classification (OpenAI production, Anthropic optional)
      sentiment / impact / confidence / direction / news type
  → equity proposal (long on up; short on down when enabled)
  → learned position sizing (evidence-weighted from broker-confirmed outcomes)
  → risk gate (caps + percent-of-equity kill switch)
  → Alpaca PAPER market order  →  paper_trades / rejected_trades
  → broker-truth reconciliation (fills, realized P&L, SPY benchmark)
  → event-study measurement (price reactions at 10s/1m/5m/30m/1h/EOD)
  → end-of-day report (console or Discord webhook)
```

Three learning layers persist forever:

- **Event study** (`price_reactions`): which news types/scores actually move
  prices — the evidence for edge.
- **Learned equity sizing** (`paper_equity_sizing_decisions`): position sizes
  scale with broker-confirmed historical outcomes for comparable signals, and
  abstain without evidence.
- **Learned exits** (`src/paper/exitPolicy.js`): stop-loss and take-profit
  levels adapt to the observed win/loss distribution once enough confirmed
  outcomes exist (`exit_*` strategy settings; bounded by hard rails).

`scripts/compactDatabase.js` keeps the database from bloating: old raw
payloads/model responses are nulled after `RETENTION_RAW_DAYS` (default 90),
while the learning evidence (trades, outcomes, reactions, sizing decisions) is
never touched.

## Quickstart

Requires Node >= 22.5 and an Alpaca **paper** account (its key pair also
serves the news + market-data APIs). Copy `.env.example` to `.env` and fill in
`ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`.

```bash
npm test                                # 459 offline tests, no network, no keys
npm run migrate                         # create/upgrade data/exalted_fable.sqlite

# One decision cycle, dry run (no order):
node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT --classifier openai

# Execute PAPER orders:
node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL --classifier openai --execute-paper

# Market-hours loop (the daily driver; Ctrl+C to stop):
node --env-file=.env scripts/runPaperTradingLoop.js --classifier openai \
  --interval-minutes 15 --execute-paper --send-discord-eod-report

# End-of-day report:
node --env-file=.env scripts/sendPaperEodReport.js --dry-run     # preview
node --env-file=.env scripts/sendPaperEodReport.js --send-discord

# Kill switch (manual control; auto-trips at MAX_DAILY_LOSS_USD):
node --env-file=.env scripts/setKillSwitch.js --status | --on --reason "..." | --off

# Retention (dry-run by default):
node --env-file=.env scripts/compactDatabase.js [--apply] [--days 90] [--vacuum]
```

Research one-shots: `ingestAlpacaNewsOnce.js` (fetch + store news),
`classifyNewsOnce.js` (score stored events), `measureReactionsOnce.js`
(price-reaction measurement), `reportEventStudySummary.js` (read-only research
snapshot), `runMvpPipelineOnce.js` (whole research loop, never trades),
`listMeasurementCandidates.js`. Connectivity checks: `smokeAlpacaNews.js`,
`smokeAlpacaTrades.js`, `smokeDiscordWebhook.js`.

## Configuration

- `.env` (secrets + risk knobs — see `.env.example`): Alpaca/OpenAI keys,
  `MAX_DAILY_LOSS_PCT` / `MAX_DAILY_LOSS_USD` (kill switch),
  `MAX_POSITION_SIZE_USD`, `MAX_TRADES_PER_DAY`, `MAX_TOTAL_EXPOSURE_USD`
  (cap defaults), `PAPER_ENABLE_SHORTS` / `PAPER_ENABLE_MARGIN` (off by
  default), `RETENTION_RAW_DAYS`, optional `DISCORD_WEBHOOK_URL`.
- `config/strategy-settings.example.json` → copy to
  `data/strategy-settings.json` for non-secret runtime defaults (symbols,
  thresholds, caps, sizing knobs, `exit_*` exit policy). Explicit CLI flags
  always win.

## News providers

Pluggable `NewsProvider` contract (`docs/providers.md`):

- **Alpaca News** — primary source, real HTTP transport, free with the Alpaca
  account keys.
- **Benzinga** — optional plug-in adapter (transport-injected). A working HTTP
  transport is parked on the `backup/pre-cleanup` branch for when a Benzinga
  key is in play.

Adding a source = one adapter file + one registry entry; nothing downstream
changes.

## Architecture

```
scripts/                thin CLIs (parse flags, build clients, print reports)
src/paper/tradeCycle.js the decision cycle (exits→ingest→classify→size→risk→order→record)
src/paper/              alpacaPaperClient (paper-only), paperTradeProposal,
                        paperRisk, riskState (kill switch), equitySizing,
                        exitPolicy + positionMonitor (learned exits),
                        brokerTruth (+SPY benchmark), accountCapabilities,
                        marketHours, paperTradingLoop
src/providers/          NewsProvider contract + Alpaca/Benzinga/mock adapters
src/sentiment/          OpenAI/Anthropic classifiers, strict JSON parsing
src/eventStudy/         price-reaction measurement
src/ingestion/          fetch→store, classify→store
src/database/           SQLite migrations + storage helpers
src/prices/             Alpaca trades price source (read-only market data)
src/notifications/      Discord webhook client
```

Everything is dependency-injected: `npm test` runs the full suite offline with
zero network calls and zero keys.

## Testing

```bash
npm test        # node --test "tests/*.test.js"
```

Every test uses in-memory SQLite and injected fakes. A fetch stub proves no
real network is touched.

## Project docs

- `STATUS.md` — current checkpoint (source of truth for state).
- `CLAUDE.md` — standing rules for AI-assisted development.
- `BUILD_PLAN.md` — delivered phases + roadmap.
- `docs/providers.md` — provider abstraction guide.
- `docs/archive/` — historical design documents.
