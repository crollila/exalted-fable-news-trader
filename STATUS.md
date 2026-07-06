# STATUS.md - ExaltedFable project checkpoint

Purpose: the latest safe state of the project, for AI assistants and future me.
Keep this file short and factual. It is a checkpoint, not a changelog.

## Current Status

- Current phase: **simplified core + managed exits, running research
  sessions.** The 2026-07 simplification (pushed as `b9ab7d3..50250f4`) was
  followed by two features requested on review: a percent-of-equity daily-loss
  kill switch (`92b2c34`) and the self-adjusting exit engine (`f161bf2`), plus
  this docs refresh.
- Verification: full `npm test` passes at 476/476 with zero live network calls.
- The system is a PAPER-only AI news event-study and Alpaca paper-trading
  research system. Live trading remains disabled by default and impossible
  through the paper client: order submission is hard-wired to
  `https://paper-api.alpaca.markets`; there is no live endpoint override.
- `AGENTS.md` is intentionally untracked and must remain untracked unless a
  later prompt explicitly changes that.

## What the 2026-07 simplification changed

- **Parked** the pre-cleanup WIP (duplicate-suppression audits, backlog
  terminals, provider cursors, Benzinga HTTP transport) on the
  `backup/pre-cleanup` branch (commit `dd69ea5`). Cherry-pick from there if a
  piece is wanted later — notably `src/providers/benzingaNewsHttpTransport.js`.
- **Deleted** options trading end-to-end, the Polygon/Alpha-Vantage provider
  stubs, the research-target scraper, the candidate-universe ranker, and the
  two advisory recommendation engines (strategyLearning,
  constraintRecommendations). Migration `011_simplify.sql` dropped their
  tables (pre-migration DB backup: `data/exalted_fable.pre-simplify.bak`).
- **Extracted** the whole decision cycle into `src/paper/tradeCycle.js`;
  `scripts/runPaperTradingOnce.js` is now a ~250-line CLI that re-exports the
  cycle's public surface.
- **Added** the daily-loss kill switch (`src/paper/riskState.js` over the
  `risk_state` table; auto-trips at `MAX_DAILY_LOSS_USD`, manual control via
  `scripts/setKillSwitch.js`) — closing the CLAUDE.md risk-rule gap — and
  folded the legacy `MAX_*` env vars into real cap defaults.
- **Added** data retention (`scripts/compactDatabase.js`,
  `RETENTION_RAW_DAYS=90`): old raw payloads/model responses are nulled and
  old account snapshots pruned; learning evidence is kept forever.
- **Repo size:** ~29.5k lines → ~21k; tests 579 → 459 (options/advisory/stub
  tests removed, kill-switch + retention tests added).

## Current Architecture Notes

- Providers: Alpaca News (primary, real HTTP transport) + Benzinga (optional
  transport-injected plug-in) behind the pluggable `NewsProvider` contract.
- Classification: OpenAI (production) / Anthropic (optional) classifiers with
  strict JSON parsing; failures recorded as data (`parser_status`).
- Trading: equities only (long by default; shorts behind
  `PAPER_ENABLE_SHORTS` + `--allow-shorts`), learned equity sizing with
  broker-confirmed evidence, margin-aware risk caps, per-day kill switch
  (percent-of-equity via `MAX_DAILY_LOSS_PCT`, USD fallback).
- Exits: every cycle manages open positions BEFORE new entries — stop-loss /
  take-profit / max-hold (`exitPolicy.js` + `positionMonitor.js`, migration
  012 exit-order columns). Stop/target re-derive from broker-confirmed
  win/loss sizes each cycle, clamped to hard rails; exits run even while the
  kill switch is active. Closed exits write broker-confirmed realized P&L,
  which feeds the kill switch and both learning layers.
- Truth & measurement: broker-truth reconciliation with SPY-benchmark
  performance snapshots; event-study price reactions at 10s/1m/5m/30m/1h/EOD.
- Reporting: sanitized end-of-day report (console dry-run default; Discord
  with `--send-discord`), kill-switch status included.
- `.env` remains manual-only; the bot does not edit `.env` and must not
  expose secrets.

## Known Warnings / Technical Debt

- The kill switch's automatic trigger uses broker-confirmed realized P&L, so
  it reacts after fills are confirmed (conservative-slow, not tick-instant).
- Learned sizing evidence stays limited until enough broker-confirmed,
  ExaltedFable-owned closed outcomes accumulate with realized P&L.
- `marketHours.js` has no holiday calendar (Alpaca clock is preferred when
  credentialed; the local fallback is Mon-Fri regular hours only).
- Dormant columns from removed features remain on already-migrated local DBs
  (e.g. `paper_runtime_sessions.options_used`) — harmless; SQLite has no
  conditional DROP COLUMN.

## Next Recommended Task

Run the paper loop through several real market-hours sessions
(`--classifier openai --execute-paper`). The first execute run will also
close the 6 stale open positions from earlier sessions via max-hold exits.
Then review the event-study summary and exit-reason breakdown for the first
edge/no-edge evidence before considering any strategy changes.

## Maintenance Rule

After every approved commit, update this checkpoint with:

- latest commit hash and message
- current phase
- completed work
- current architecture notes
- known warnings or technical debt
- next recommended task
