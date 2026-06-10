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

## Old V1 reference

https://github.com/crollila/High-Frequency-Trading-Algorithm-with-Instant-News-Sentiment-Analysis

## Documentation

- [News provider adapters](docs/providers.md) — provider abstraction, canonical event path, injected-transport pattern, and fixture-only safety.
