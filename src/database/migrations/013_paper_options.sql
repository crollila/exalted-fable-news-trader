-- 013_paper_options.sql — recreate paper_option_trades for the restored PAPER
-- options trading (long calls/puts with monitored exits). 011_simplify dropped
-- the original (created by 004, extended by 005/006); this consolidates the
-- full column set into one CREATE. IF-NOT-EXISTS-free on purpose: the runner
-- applies each migration exactly once, and 011 guarantees the table is absent.
CREATE TABLE paper_option_trades (
  id                           INTEGER PRIMARY KEY,
  paper_trade_id               INTEGER REFERENCES paper_trades(id) ON DELETE SET NULL,
  news_event_id                INTEGER REFERENCES news_events(id) ON DELETE SET NULL,
  underlying                   TEXT    NOT NULL,
  option_symbol                TEXT    NOT NULL,
  expiry                       TEXT    NOT NULL,
  strike                       REAL    NOT NULL,
  right                        TEXT    NOT NULL CHECK (right IN ('call','put')),
  quantity                     INTEGER NOT NULL CHECK (quantity > 0),
  premium_entry                REAL,
  notional_entry               REAL,
  premium_exit                 REAL,
  notional_exit                REAL,
  strategy                     TEXT    NOT NULL CHECK (strategy IN ('long_call','long_put')),
  strategy_rationale           TEXT,
  exit_policy                  TEXT    NOT NULL,
  exit_reason                  TEXT,
  status                       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','canceled')),
  closed_at                    TEXT,
  -- monitored execution lifecycle (formerly migration 005)
  lifecycle_state              TEXT,
  entry_order_id               TEXT,
  entry_order_status           TEXT,
  entry_limit_price            REAL,
  opened_at                    TEXT,
  exit_order_id                TEXT,
  exit_order_status            TEXT,
  exit_limit_price             REAL,
  realized_pnl_usd             REAL,
  exit_attempts                INTEGER NOT NULL DEFAULT 0,
  last_checked_at              TEXT,
  -- broker-truth fields (formerly migration 006)
  entry_filled_qty             REAL,
  entry_filled_avg_price       REAL,
  entry_filled_at              TEXT,
  exit_filled_qty              REAL,
  exit_filled_avg_price        REAL,
  exit_filled_at               TEXT,
  broker_position_qty          REAL,
  broker_position_market_value REAL,
  broker_unrealized_pl         REAL,
  created_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_option_trades_symbol ON paper_option_trades (option_symbol);
CREATE INDEX idx_paper_option_trades_underlying ON paper_option_trades (underlying);
CREATE INDEX idx_paper_option_trades_event ON paper_option_trades (news_event_id);
CREATE INDEX idx_paper_option_trades_lifecycle ON paper_option_trades (lifecycle_state);
