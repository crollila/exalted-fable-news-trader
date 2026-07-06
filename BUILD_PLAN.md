# BUILD_PLAN.md — ExaltedFable

## Delivered (Phases 0–7, plus the 2026-07 simplification)

The original 8-phase build plan is complete and its scope was then re-cut by
the 2026-07 simplification (see `STATUS.md`):

- **Phase 0 — Setup:** clean V2 repo, `.env.example`, tests-first workflow.
- **Phase 1 — Measurement foundation:** SQLite migrations for `news_events`,
  `sentiment_scores`, `price_reactions`, `paper_trades`, `risk_state`,
  `rejected_trades`.
- **Phase 2 — Provider abstraction:** pluggable `NewsProvider` contract;
  Alpaca (primary) + Benzinga (optional plug-in) survived the simplification.
- **Phase 3 — Sentiment/classification:** versioned prompts, OpenAI/Anthropic
  classifiers, strict parsing with failures-as-data.
- **Phase 4 — Event study:** price reactions at 10s/1m/5m/30m/1h/EOD with
  unavailable-price outcomes recorded as data.
- **Phase 5 — Paper trading journal:** paper-only Alpaca client (hard-wired
  paper endpoint), fills, slippage-ready journal, broker-truth reconciliation.
- **Phase 6 — Risk engine:** notional/exposure/daily caps, shorts/margin
  gating, and (added 2026-07) the daily-loss kill switch over `risk_state`.
- **Phase 7 — Reporting:** sanitized EOD report with SPY-benchmark
  performance, Discord delivery.
- **Phase 8 (superseded):** "strategy improvements" grew into options trading,
  advisory recommendation engines, universe ranking, and scraper planning —
  all removed by the 2026-07 simplification. The two learning layers that
  survived are learned equity sizing and the event study; data retention
  (`scripts/compactDatabase.js`) keeps the DB lean forever.

## Roadmap

1. **Prove/deny edge with data.** Run the paper loop through real market-hours
   sessions and accumulate enough broker-confirmed outcomes to read the
   event-study expectancy by news type / score bucket.
2. **Tune the signal, not the machinery.** Adjust thresholds and the
   classifier prompt based on measured expectancy; drop news types with no
   edge.
3. ~~**Exits.**~~ Delivered 2026-07-06: a learned exit policy
   (stop-loss / take-profit / max-hold in `src/paper/exitPolicy.js` +
   `positionMonitor.js`) closes positions every cycle, with the stop/target
   adapting to broker-confirmed win/loss sizes inside hard rails. Next
   refinement candidate: per-news-type exit parameters once the event study
   shows they differ.
