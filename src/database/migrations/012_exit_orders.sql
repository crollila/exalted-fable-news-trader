-- 012_exit_orders.sql — exit-order tracking on paper_trades so the position
-- monitor can submit a PAPER exit, poll its broker status across cycles, and
-- close the row with broker-confirmed numbers. Additive only.
ALTER TABLE paper_trades ADD COLUMN exit_order_id     TEXT;
ALTER TABLE paper_trades ADD COLUMN exit_order_status TEXT;
ALTER TABLE paper_trades ADD COLUMN exit_submitted_at TEXT;
