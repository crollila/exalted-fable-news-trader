-- 008_paper_cap_and_benchmark_metadata.sql - Sanitized cap and benchmark metadata.
--
-- ADDITIVE ONLY. Stores explanatory PAPER-only reporting metadata. It does not
-- enable trading, change strategy thresholds, call providers, or store secrets.

ALTER TABLE paper_equity_sizing_decisions
  ADD COLUMN effective_risk_caps_json TEXT;

ALTER TABLE paper_strategy_performance_snapshots
  ADD COLUMN spy_baseline_target_at TEXT;
ALTER TABLE paper_strategy_performance_snapshots
  ADD COLUMN spy_current_target_at TEXT;
ALTER TABLE paper_strategy_performance_snapshots
  ADD COLUMN spy_baseline_source TEXT;
ALTER TABLE paper_strategy_performance_snapshots
  ADD COLUMN spy_current_source TEXT;
ALTER TABLE paper_strategy_performance_snapshots
  ADD COLUMN spy_baseline_alignment_status TEXT;
ALTER TABLE paper_strategy_performance_snapshots
  ADD COLUMN spy_current_alignment_status TEXT;
ALTER TABLE paper_strategy_performance_snapshots
  ADD COLUMN spy_unavailable_reason TEXT;
