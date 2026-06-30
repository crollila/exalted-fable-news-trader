-- 006_paper_broker_truth_performance.sql - PAPER broker truth + benchmark snapshots.
--
-- ADDITIVE ONLY. No live trading is enabled here. Existing trade/session history
-- is preserved; old rows get NULL broker-truth fields until reconciled.

-- Broker-confirmed equity order / position truth for ExaltedFable-owned rows.
ALTER TABLE paper_trades ADD COLUMN broker_order_id               TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_client_order_id        TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_order_status           TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_order_type             TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_submitted_at           TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_filled_qty             REAL;
ALTER TABLE paper_trades ADD COLUMN broker_filled_avg_price       REAL;
ALTER TABLE paper_trades ADD COLUMN broker_filled_at              TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_canceled_at            TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_expired_at             TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_replaced_at            TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_updated_at             TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_reconciled_at          TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_truth_state            TEXT;
ALTER TABLE paper_trades ADD COLUMN broker_position_qty           REAL;
ALTER TABLE paper_trades ADD COLUMN broker_position_market_value  REAL;
ALTER TABLE paper_trades ADD COLUMN broker_unrealized_pl          REAL;
ALTER TABLE paper_trades ADD COLUMN broker_realized_pnl_usd       REAL;

CREATE INDEX idx_paper_trades_broker_order_id ON paper_trades (broker_order_id);
CREATE INDEX idx_paper_trades_broker_truth_state ON paper_trades (broker_truth_state);

-- Extra broker-confirmed option fill / position detail. The lifecycle columns
-- from migration 005 remain the coarse source of option state.
ALTER TABLE paper_option_trades ADD COLUMN entry_filled_qty            REAL;
ALTER TABLE paper_option_trades ADD COLUMN entry_filled_avg_price      REAL;
ALTER TABLE paper_option_trades ADD COLUMN entry_filled_at             TEXT;
ALTER TABLE paper_option_trades ADD COLUMN exit_filled_qty             REAL;
ALTER TABLE paper_option_trades ADD COLUMN exit_filled_avg_price       REAL;
ALTER TABLE paper_option_trades ADD COLUMN exit_filled_at              TEXT;
ALTER TABLE paper_option_trades ADD COLUMN broker_position_qty         REAL;
ALTER TABLE paper_option_trades ADD COLUMN broker_position_market_value REAL;
ALTER TABLE paper_option_trades ADD COLUMN broker_unrealized_pl        REAL;

-- Broker-wide PAPER account snapshots. These are account truth, not proof that
-- every account-level dollar belongs to ExaltedFable.
CREATE TABLE paper_broker_account_snapshots (
  id                 INTEGER PRIMARY KEY,
  runtime_session_id INTEGER REFERENCES paper_runtime_sessions(id) ON DELETE SET NULL,
  snapshot_at        TEXT    NOT NULL,
  snapshot_kind      TEXT    NOT NULL DEFAULT 'reconcile',
  account_status     TEXT,
  equity             REAL,
  portfolio_value    REAL,
  cash               REAL,
  buying_power       REAL,
  data_quality       TEXT    NOT NULL,
  warnings_json      TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_broker_account_snapshots_session
  ON paper_broker_account_snapshots (runtime_session_id, snapshot_at);

-- Session performance snapshots align broker-confirmed account values,
-- ExaltedFable-owned exposure, and SPY benchmark prices on the same timestamps.
CREATE TABLE paper_strategy_performance_snapshots (
  id                            INTEGER PRIMARY KEY,
  runtime_session_id            INTEGER REFERENCES paper_runtime_sessions(id) ON DELETE SET NULL,
  account_snapshot_id           INTEGER REFERENCES paper_broker_account_snapshots(id) ON DELETE SET NULL,
  baseline_account_snapshot_id  INTEGER REFERENCES paper_broker_account_snapshots(id) ON DELETE SET NULL,
  snapshot_at                   TEXT    NOT NULL,
  snapshot_kind                 TEXT    NOT NULL DEFAULT 'reconcile',
  broker_equity_baseline        REAL,
  broker_equity_current         REAL,
  broker_portfolio_value_current REAL,
  broker_account_return_pct     REAL,
  spy_baseline_at               TEXT,
  spy_baseline_price            REAL,
  spy_current_at                TEXT,
  spy_current_price             REAL,
  spy_return_pct                REAL,
  broker_account_excess_return_pct REAL,
  bot_gross_exposure            REAL,
  bot_realized_pnl_usd          REAL,
  bot_open_position_count       INTEGER NOT NULL DEFAULT 0,
  bot_orders_submitted          INTEGER NOT NULL DEFAULT 0,
  bot_orders_filled             INTEGER NOT NULL DEFAULT 0,
  bot_orders_open               INTEGER NOT NULL DEFAULT 0,
  bot_orders_canceled           INTEGER NOT NULL DEFAULT 0,
  bot_orders_rejected           INTEGER NOT NULL DEFAULT 0,
  bot_orders_expired            INTEGER NOT NULL DEFAULT 0,
  bot_orders_replaced           INTEGER NOT NULL DEFAULT 0,
  data_quality                  TEXT    NOT NULL,
  warnings_json                 TEXT    NOT NULL,
  created_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_strategy_performance_snapshots_session
  ON paper_strategy_performance_snapshots (runtime_session_id, snapshot_at);
