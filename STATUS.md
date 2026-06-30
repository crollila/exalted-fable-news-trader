# STATUS.md - ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status

- Latest confirmed commit: `af0579e` - `feat(paper): add broker truth and SPY benchmark reporting`.
- Current working tree: learned, portfolio-aware PAPER equity target sizing is implemented but not yet committed.
- Verification: full `npm test` passes at 564/564 with zero live network calls in tests.
- Current system is a PAPER-only AI news event-study and Alpaca paper-trading research system.
- Live trading remains disabled by default and impossible through the current paper client: order submission is hard-wired to `https://paper-api.alpaca.markets`; there is no live endpoint override.
- `AGENTS.md` is intentionally untracked and must remain untracked unless a later prompt explicitly changes that.

## Working Tree Implementation

The uncommitted learned equity sizing layer adds:

- Additive migration `007_paper_equity_sizing_decisions.sql` for sanitized immutable PAPER equity sizing audit rows.
- Pure sizing engine `src/paper/equitySizing.js` with `cold_start`, `evidence_weighted`, and `abstain` decisions.
- Runtime helpers for broker-confirmed ExaltedFable-owned equity evidence, current owned exposure snapshots, duplicate-attempt checks, and sizing audit insertion.
- One-shot/loop equity wiring that uses learned sizing when `--qty` is absent and preserves explicit `--qty` as a labeled manual override.
- Console and EOD report updates for requested vs approved size, sizing mode, manual override status, evidence count/quality, and sizing data-quality warnings.
- Conservative strategy-settings controls for minimum comparable sample size, cold-start weight, max learned target weight, and optional confidence/impact scaling.
- Offline tests for sizing formula, provenance isolation, migration coverage, runtime audit storage, one-shot execution, settings validation, and EOD report rendering.

## Sizing Rules

- Applies to PAPER equities only. Options retain their bounded contract behavior and are excluded from learned equity sizing.
- Historical learning evidence requires ExaltedFable-owned broker order provenance, broker-confirmed fill quantity/price, broker-confirmed realized P&L, and compatible model/prompt metadata.
- Manual Alpaca account activity and broker-wide account returns are never learning evidence.
- Manual `--qty` override trades are labeled and excluded from learned evidence once audited.
- Legacy rows without sizing metadata are used only when score provenance is unambiguous.
- Comparable hierarchy: exact ticker/news-type/direction/score bucket, then news-type/direction/score bucket, then direction/score bucket, then cold start or abstain.
- Missing reference price, missing broker equity, duplicate/stale replay status, losing/uncertain comparable evidence, or insufficient notional for one whole share causes abstention/rejection rather than a fallback to one share.
- `paperRisk` remains authoritative for account, buying-power, exposure, daily order/notional, margin/short, and cap vetoes.

## Current Architecture Notes

- Provider abstraction is in place for Alpaca News, Benzinga, Alpha Vantage, Polygon/Massive, and future providers.
- Classification supports the offline/manual baseline plus explicit model-backed classifiers; provider-supplied sentiment remains provider metadata unless a reviewed sentiment task changes that.
- Event-study storage and measurement are implemented with unavailable-price outcomes recorded as data.
- Paper trading supports dry-run-default equities, shorts when gated, monitored long-option paper execution when explicitly gated, broker-truth reconciliation, SPY benchmark reporting, and learned PAPER equity target sizing.
- Runtime sessions, candidate-universe selection, advisory-only recommendations, strategy-settings learning, and Discord EOD reporting are implemented.
- `.env` remains manual-only; the bot does not edit `.env` and must not expose secrets.

## Known Warnings / Technical Debt

- Learned sizing is PAPER-only and has not yet been validated against a real Alpaca paper market-hours session.
- Evidence quality will remain limited until enough broker-confirmed, ExaltedFable-owned closed outcomes accumulate with realized P&L.
- Broker account equity/buying power used for sizing capacity can include manual Alpaca account activity; learning evidence and owned exposure do not.
- Realized equity P&L is unavailable unless broker/local data provides a confirmed realized value.

## Next Recommended Task

Review and commit the learned PAPER equity target-sizing patch, then validate it during a real PAPER market-hours session before considering any broader learning-driven portfolio changes.

## Maintenance Rule

After every approved commit, update this checkpoint with:

- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
