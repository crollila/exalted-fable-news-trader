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
