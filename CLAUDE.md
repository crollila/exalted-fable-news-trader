# CLAUDE.md — ExaltedFable

You are helping build ExaltedFable, an AI news event-study and Alpaca paper-trading research system.

## Hard rules

- Do not enable live trading.
- Do not write code that can trade live unless explicitly requested later.
- `LIVE_TRADING_ENABLED=false` must remain the default.
- Never read, print, commit, or expose API keys.
- Never modify `.env` directly.
- Use `.env.example` for required environment variables.
- Do not overwrite the old V1 repo.
- Work only inside this V2 project unless explicitly told otherwise.
- Prefer small, reviewable changes.
- Explain every changed file.
- Add tests or validation scripts for important logic.
- Do not make broad rewrites without approval.

## Project goal

Turn the original prototype into a measurable research and paper-trading system that can prove whether AI-scored news events have trading edge.

## Required architecture

Use modular components:

- news providers
- database layer
- sentiment/classification engine
- event-study engine
- paper-trading execution
- risk engine
- reporting engine

## News providers

The system should support pluggable news providers:

- Alpaca News
- Benzinga
- Polygon/Massive
- Alpha Vantage
- future providers

Do not hard-code the system around one source.

## Data to store

Store:

- raw news event
- provider
- provider event ID
- ticker
- headline
- body/summary
- published timestamp
- received timestamp
- duplicate group
- news type
- sentiment score
- model response
- confidence
- theoretical entry price
- actual paper fill
- slippage
- exit price
- P&L
- max adverse excursion
- max favorable excursion
- exit reason
- trade reason

## Trading/risk rules

- Paper trading only.
- Add max position size.
- Add max daily loss.
- Add max trades per day.
- Add total exposure limit.
- Add kill switch.
- Log every rejected trade and why it was rejected.

## Development workflow

Before coding:
1. Inspect relevant files.
2. Summarize current state.
3. Propose a small change.
4. Wait for approval if the change is large.

After coding:
1. List changed files.
2. Explain what changed.
3. Explain how to test.
4. Explain risks/limitations.
