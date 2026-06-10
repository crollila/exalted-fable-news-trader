-- 001_initial.sql — Phase 1 foundation schema for ExaltedFable.
--
-- TIMESTAMP CONVENTION: all timestamps are UTC ISO-8601 TEXT,
-- e.g. '2026-06-09T14:30:00.000Z'. Default created_at values use
-- strftime('%Y-%m-%dT%H:%M:%fZ','now'), which produces this format.
--
-- All money values are USD stored as REAL. All ids are INTEGER PRIMARY KEY
-- (SQLite rowid aliases).

-- ---------------------------------------------------------------------------
-- news_events: one row per raw news item received from any provider.
-- ---------------------------------------------------------------------------
CREATE TABLE news_events (
  id                INTEGER PRIMARY KEY,
  provider          TEXT    NOT NULL,              -- e.g. 'alpaca', 'benzinga', 'polygon', 'alpha_vantage'
  provider_event_id TEXT,                          -- provider's own id, if any
  ticker            TEXT    NOT NULL,
  headline          TEXT    NOT NULL,
  body              TEXT,                          -- body or summary text
  published_at      TEXT    NOT NULL,              -- UTC ISO-8601 (provider's publish time)
  received_at       TEXT    NOT NULL,              -- UTC ISO-8601 (when WE received it; latency = received - published)
  dedup_group       TEXT,                          -- shared key for cross-provider duplicates of the same story
  news_type         TEXT,                          -- e.g. 'earnings', 'fda', 'mna', 'macro' (classified later)
  raw_payload       TEXT,                          -- original provider JSON, for audit/replay
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A provider must not insert the same event twice (only when it supplies an id).
CREATE UNIQUE INDEX idx_news_events_provider_event
  ON news_events (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX idx_news_events_ticker_published ON news_events (ticker, published_at);
CREATE INDEX idx_news_events_dedup_group ON news_events (dedup_group) WHERE dedup_group IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sentiment_scores: model scoring of a news event. One event may be scored
-- multiple times (different models / prompt versions).
-- ---------------------------------------------------------------------------
CREATE TABLE sentiment_scores (
  id              INTEGER PRIMARY KEY,
  news_event_id   INTEGER NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  model           TEXT    NOT NULL,                -- e.g. 'gpt-4o-mini', 'claude-haiku'
  prompt_version  TEXT    NOT NULL,                -- version the prompt used, for reproducibility
  sentiment_score REAL,                            -- normalized, e.g. -1.0 .. +1.0
  news_type       TEXT,                            -- model-classified type
  confidence      REAL,                            -- 0.0 .. 1.0
  raw_response    TEXT,                            -- full raw model output, for audit
  parse_ok        INTEGER NOT NULL DEFAULT 1,      -- 0 if model output was malformed
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_sentiment_scores_event ON sentiment_scores (news_event_id);

-- ---------------------------------------------------------------------------
-- price_reactions: measured price movement around a news event (event study).
-- One row per (event, horizon), e.g. horizons '1m', '5m', '30m', '1d'.
-- ---------------------------------------------------------------------------
CREATE TABLE price_reactions (
  id              INTEGER PRIMARY KEY,
  news_event_id   INTEGER NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  horizon         TEXT    NOT NULL,                -- e.g. '1m', '5m', '30m', '1d'
  baseline_price  REAL    NOT NULL,                -- price at/just before event
  reaction_price  REAL    NOT NULL,                -- price at end of horizon
  return_pct      REAL    NOT NULL,                -- (reaction - baseline) / baseline
  high_price      REAL,                            -- intra-horizon high
  low_price       REAL,                            -- intra-horizon low
  volume          REAL,
  measured_at     TEXT    NOT NULL,                -- UTC ISO-8601 when measurement completed
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (news_event_id, horizon)
);

-- ---------------------------------------------------------------------------
-- paper_trades: paper executions only. This system never trades live.
-- ---------------------------------------------------------------------------
CREATE TABLE paper_trades (
  id                     INTEGER PRIMARY KEY,
  news_event_id          INTEGER REFERENCES news_events(id) ON DELETE SET NULL,
  ticker                 TEXT    NOT NULL,
  side                   TEXT    NOT NULL CHECK (side IN ('buy','sell')),
  quantity               REAL    NOT NULL CHECK (quantity > 0),
  theoretical_entry_price REAL,                    -- price when signal fired
  fill_price             REAL,                     -- actual paper fill
  slippage               REAL,                     -- fill - theoretical (signed)
  entry_at               TEXT,                     -- UTC ISO-8601
  exit_price             REAL,
  exit_at                TEXT,                     -- UTC ISO-8601
  pnl_usd                REAL,
  max_adverse_excursion  REAL,                     -- worst unrealized loss during trade (USD)
  max_favorable_excursion REAL,                    -- best unrealized gain during trade (USD)
  trade_reason           TEXT,                     -- why the trade was entered
  exit_reason            TEXT,                     -- e.g. 'take_profit', 'stop_loss', 'timeout', 'kill_switch'
  status                 TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','canceled')),
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_trades_ticker ON paper_trades (ticker);
CREATE INDEX idx_paper_trades_event ON paper_trades (news_event_id);

-- ---------------------------------------------------------------------------
-- risk_state: one row per trading day; running totals the risk engine checks.
-- ---------------------------------------------------------------------------
CREATE TABLE risk_state (
  id                  INTEGER PRIMARY KEY,
  trading_day         TEXT    NOT NULL UNIQUE,     -- UTC date 'YYYY-MM-DD'
  realized_pnl_usd    REAL    NOT NULL DEFAULT 0,
  trades_count        INTEGER NOT NULL DEFAULT 0,
  open_exposure_usd   REAL    NOT NULL DEFAULT 0,
  kill_switch_active  INTEGER NOT NULL DEFAULT 0,  -- 1 = halt all new trades
  kill_switch_reason  TEXT,
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- rejected_trades: every trade the risk engine refused, and why.
-- reason is mandatory — a rejection without a reason is a logging bug.
-- ---------------------------------------------------------------------------
CREATE TABLE rejected_trades (
  id            INTEGER PRIMARY KEY,
  news_event_id INTEGER REFERENCES news_events(id) ON DELETE SET NULL,
  ticker        TEXT    NOT NULL,
  side          TEXT,
  quantity      REAL,
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  rejected_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_rejected_trades_ticker ON rejected_trades (ticker);
