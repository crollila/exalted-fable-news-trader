# PROJECT_CONTEXT.md — ExaltedFable

ExaltedFable is a clean V2 rebuild of a Node.js AI news trading bot.

Old V1 repo:
https://github.com/crollila/High-Frequency-Trading-Algorithm-with-Instant-News-Sentiment-Analysis

## V2 objective

Build a research-first and paper-trading-first system that can determine whether AI-scored news events have measurable trading edge.

## Design philosophy

- Measurement before optimization.
- Paper trading before live trading.
- Modular providers before hard-coded APIs.
- Logs and database records before strategy changes.
- Small, reviewable changes before large rewrites.

## Key components

- News providers
- Database
- Sentiment/classification
- Event study
- Paper execution
- Risk engine
- Reports

## Live trading

Disabled by default.
Do not enable unless explicitly requested much later.
