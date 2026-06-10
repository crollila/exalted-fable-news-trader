# BUILD_PLAN.md — ExaltedFable

## Phase 0 — Setup

Goal: Create a clean V2 repo without touching V1.

Tasks:
1. Create `ExaltedFable` folder.
2. Initialize Git.
3. Add project source files.
4. Add `.gitignore`.
5. Add `.env.example`.
6. Add initial README.
7. Make first commit.

## Phase 1 — Measurement Foundation

Goal: Log everything before changing strategy logic.

Tasks:
1. Add SQLite database layer.
2. Add schema/migrations for:
   - news_events
   - sentiment_scores
   - price_reactions
   - paper_trades
   - risk_state
   - rejected_trades
3. Add database utility functions.
4. Add basic validation tests.

## Phase 2 — News Provider Abstraction

Goal: Avoid hard-coded Benzinga dependence.

Tasks:
1. Define standard `NewsProvider` interface.
2. Add provider result normalization.
3. Add Alpaca News provider.
4. Add Benzinga provider if key available.
5. Add Alpha Vantage provider for slower research/news sentiment.
6. Add Polygon/Massive provider if useful.
7. Store provider metadata in database.

## Phase 3 — Sentiment + Classification

Goal: Score and classify every event.

Tasks:
1. Create model prompt versioning.
2. Classify news type.
3. Score sentiment/impact.
4. Store raw model response.
5. Store confidence and parser status.
6. Add fallback handling when model output is malformed.

## Phase 4 — Event Study

Goal: Prove whether the signal predicts price movement.

Tasks:
1. Record price at event time.
2. Record price after:
   - 10s
   - 1m
   - 5m
   - 30m
   - 1h
   - EOD
3. Calculate reaction returns.
4. Group results by score bucket, news type, ticker, provider, time of day.

## Phase 5 — Paper Trading Journal

Goal: Compare theoretical trades against actual paper fills.

Tasks:
1. Log signal time and theoretical entry price.
2. Submit paper orders only.
3. Record actual fill price/time.
4. Calculate slippage.
5. Record exits.
6. Calculate realized P&L.
7. Track max adverse/favorable excursion.

## Phase 6 — Risk Engine

Goal: Prevent dumb losses in paper and later live-small testing.

Tasks:
1. Max position size.
2. Max total exposure.
3. Max daily loss.
4. Max trades per day.
5. Kill switch.
6. Rejected-trade logging.

## Phase 7 — Reporting

Goal: Decide what actually has edge.

Reports:
1. Expectancy by score bucket.
2. Expectancy by news type.
3. Expectancy by provider.
4. Expectancy by ticker.
5. Expectancy by time of day.
6. Fill quality.
7. Slippage.
8. Long vs short performance.
9. Liquidity bucket performance.

## Phase 8 — Strategy Improvements

Only start after measurement exists.

Possible improvements:
1. Remove weak news categories.
2. Tune thresholds.
3. Separate long and short logic.
4. Add liquidity/spread filters.
5. Add duplicate suppression.
6. Optimize exits.
7. Add walk-forward validation.
