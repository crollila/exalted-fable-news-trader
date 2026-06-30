# STATUS.md - ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status

- Latest confirmed commit: `879950f` - `docs(status): repair current checkpoint for monitored paper options`.
- Current working tree: broker-truth reconciliation and aligned SPY benchmark performance reporting are implemented but not yet committed.
- Verification: full `npm test` passes at 552/552 with zero live network calls in tests.
- Current system is a PAPER-only AI news event-study and Alpaca paper-trading research system.
- Live trading remains disabled by default and impossible through the current paper client: order submission is hard-wired to `https://paper-api.alpaca.markets`; there is no live endpoint override.
- `AGENTS.md` is intentionally untracked and must remain untracked unless a later prompt explicitly changes that.

## Working Tree Implementation

The uncommitted broker-truth layer adds:

- Additive migration `006_paper_broker_truth_performance.sql` for broker order/fill fields on `paper_trades`, broker fill/position fields on `paper_option_trades`, broker account snapshots, and strategy performance snapshots.
- `src/paper/brokerTruth.js` for PAPER-only reconciliation of ExaltedFable-owned equity/option orders, broker-confirmed exposure/P&L calculation when available, account-equity snapshots, and SPY-aligned benchmark return calculation through the existing `PriceSource` path.
- One-shot and loop wiring that records broker-truth/performance snapshots when PAPER credentials are available.
- EOD report updates for submitted-vs-filled counts, open/canceled/rejected/expired/replaced counts, owned exposure, broker-confirmed owned P&L when available, broker account return, SPY return, account excess return, unavailable owned return, and data-quality warnings.
- Offline tests for reconciliation, benchmark alignment, missing-data behavior, migration coverage, report rendering, and sanitized PAPER client fields.

## Broker Truth Rules

- Reconcile only bot-owned records: `paper_trades.broker_order_id`, legacy `paper_trades.trade_reason` markers containing `paper order <id>`, and `paper_option_trades` entry/exit order ids.
- Manual Alpaca positions/orders are never counted as ExaltedFable-owned exposure.
- Broker-wide account equity is stored separately from ExaltedFable-owned exposure; account returns can be affected by manual Alpaca account activity and are labeled accordingly.
- Current owned exposure requires a current broker positions snapshot. If positions are unavailable, exposure is reported as unavailable rather than inferred from old fills.
- SPY benchmark prices use the existing market-data abstraction and the latest SPY trade at or before the exact baseline/current snapshot timestamp. Missing aligned SPY data makes SPY and excess return unavailable.

## Current Architecture Notes

- Provider abstraction is in place for Alpaca News, Benzinga, Alpha Vantage, Polygon/Massive, and future providers.
- Classification supports the offline/manual baseline plus explicit model-backed classifiers; provider-supplied sentiment remains provider metadata unless a reviewed sentiment task changes that.
- Event-study storage and measurement are implemented with unavailable-price outcomes recorded as data.
- Paper trading supports dry-run-default equities, shorts when gated, monitored long-option paper execution when explicitly gated, broker-truth reconciliation, and benchmark-aware reporting.
- Runtime sessions, candidate-universe selection, advisory-only recommendations, strategy-settings learning, and Discord EOD reporting are implemented.
- `.env` remains manual-only; the bot does not edit `.env` and must not expose secrets.

## Known Warnings / Technical Debt

- The broker-truth layer is PAPER-only and has not yet been validated against a live Alpaca paper session after this patch.
- Realized equity P&L is unavailable unless broker/local data provides a confirmed realized value; option realized P&L is recorded only when broker-confirmed exit information is available.
- Broker-wide account return is truthful account data, not proof that every dollar of account movement came from ExaltedFable.
- Learning-driven sizing is still not implemented and should not be added until broker-truth data has been reviewed over real paper sessions.

## Next Recommended Task

Review and commit the broker-truth reconciliation and aligned SPY benchmark reporting layer, then validate it during a real PAPER market-hours session before any learning-driven position sizing.

## Maintenance Rule

After every approved commit, update this checkpoint with:

- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
