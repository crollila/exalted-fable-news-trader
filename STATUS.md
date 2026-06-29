# STATUS.md - ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status

- Latest confirmed commit: `576e83b` - `feat(paper): add monitored paper options execution`.
- Verification: full `npm test` passes at 543/543 with zero live network calls in tests.
- Current system is a PAPER-only AI news event-study and Alpaca paper-trading research system.
- Live trading remains disabled by default and impossible through the current paper client: order submission is hard-wired to `https://paper-api.alpaca.markets`; there is no live endpoint override.
- `AGENTS.md` is intentionally untracked and was not included in commit `576e83b`.

## Latest Confirmed Commit

`576e83b` adds monitored PAPER option execution on top of the existing paper runtime:

- Adds migration `005_paper_option_execution.sql` with additive lifecycle fields on `paper_option_trades`: entry/exit order ids and statuses, entry/exit limit prices, opened/closed timing, realized option P&L, exit attempts, last checked time, and a lifecycle-state index.
- Adds `src/paper/optionExits.js` for pure option entry/exit decisions: bounded entry/exit limit prices, pending-entry classification, take-profit, stop-loss, max-hold, mandatory same-day flatten, stale-exit requote, and realized P&L math.
- Adds `src/paper/optionMonitor.js` to reconcile only bot-owned option rows from `paper_option_trades`; it polls broker orders, reads broker positions, confirms entry fills, cancels stale unfilled entries, submits sell-to-close exits, requotes stale exits, and records unresolved states without throwing.
- Extends `src/paper/alpacaPaperClient.js` with sanitized PAPER `getOrder`, `cancelOrder`, and single-leg `submitOptionLimitOrder`; option orders are limit/day only, never market orders.
- Wires the one-shot and loop scripts so bot-owned option monitoring runs before new entries when a paper client is available.
- Extends the EOD report with an options-execution section covering opened, closed, canceled, open/unresolved counts, realized option P&L when known, exit reasons, and loud unresolved-position warnings.

## Verified Option Execution Scope

- Long calls and long puts only.
- Option entries require all gates: `PAPER_ENABLE_OPTIONS=true`, `--allow-options`, `--options-mode execute_paper`, `--execute-paper`, broker options eligibility, contract/quote validation, regular-session availability, and no pre-close entry cutoff breach.
- Entries are bounded `buy` / `limit` / `day` orders and are persisted as bot-owned `pending_entry` rows before later reconciliation.
- Exits are bounded `sell` / `limit` / `day` sell-to-close orders. The monitor sells only after confirming a broker long position for the recorded bot-owned OCC symbol.
- The monitor does not manage manual or untracked account positions.
- If broker truth is unavailable, the system defers or records unresolved state; it does not claim fills, exposure, closure, or P&L from guesses.
- Out of scope: sell-to-open, naked options, covered calls, spreads, assignment/exercise handling, multi-leg strategies, autonomous sizing, and live trading.

## Current Architecture Notes

- Provider abstraction is in place for Alpaca News, Benzinga, Alpha Vantage, Polygon/Massive, and future providers.
- Classification supports the offline/manual baseline plus explicit model-backed classifiers; provider-supplied sentiment remains provider metadata unless a reviewed sentiment task changes that.
- Event-study storage and measurement are implemented with unavailable-price outcomes recorded as data.
- Paper trading supports dry-run-default equities, shorts when gated, and monitored long-option paper execution when explicitly gated.
- Runtime sessions, candidate-universe selection, advisory-only recommendations, strategy-settings learning, and Discord EOD reporting are implemented.
- `.env` remains manual-only; the bot does not edit `.env` and must not expose secrets.

## Known Warnings / Technical Debt

- The current paper-trading report is still not a full broker-truth portfolio-performance layer. Broker dashboard state can diverge from local fills/exposure until the next reconciliation slice lands.
- Equity orders and account-level strategy performance still need broker-confirmed reconciliation before any learning-driven position sizing.
- SPY benchmark comparison over the same session window is not implemented yet.
- Realized option P&L is only recorded when broker-confirmed exit information is available; unresolved rows must be reviewed manually.
- Live paper-account verification should still be performed carefully during market hours with dry-run first.

## Next Recommended Task

Broker-truth reconciliation and aligned SPY benchmark performance reporting, before any learning-driven position sizing.

## Maintenance Rule

After every approved commit, update this checkpoint with:

- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
