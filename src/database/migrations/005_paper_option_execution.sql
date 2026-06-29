-- 005_paper_option_execution.sql — Additive columns for MONITORED PAPER option
-- order execution: entry/exit broker order ids + statuses, marketable limit
-- prices, lifecycle state, realized P&L, and timing/bookkeeping.
--
-- ADDITIVE ONLY. No live trading is enabled here. Existing rows get NULL/0
-- defaults. The coarse `status` CHECK ('open','closed','canceled') from
-- migration 004 is preserved; `lifecycle_state` carries the fine-grained state
-- (pending_entry|open|pending_exit|closed|canceled|unresolved).

ALTER TABLE paper_option_trades ADD COLUMN lifecycle_state    TEXT;
ALTER TABLE paper_option_trades ADD COLUMN entry_order_id     TEXT;
ALTER TABLE paper_option_trades ADD COLUMN entry_order_status TEXT;
ALTER TABLE paper_option_trades ADD COLUMN entry_limit_price  REAL;
ALTER TABLE paper_option_trades ADD COLUMN opened_at          TEXT;
ALTER TABLE paper_option_trades ADD COLUMN exit_order_id      TEXT;
ALTER TABLE paper_option_trades ADD COLUMN exit_order_status  TEXT;
ALTER TABLE paper_option_trades ADD COLUMN exit_limit_price   REAL;
ALTER TABLE paper_option_trades ADD COLUMN realized_pnl_usd   REAL;
ALTER TABLE paper_option_trades ADD COLUMN exit_attempts      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_option_trades ADD COLUMN last_checked_at    TEXT;

CREATE INDEX idx_paper_option_trades_lifecycle ON paper_option_trades (lifecycle_state);
