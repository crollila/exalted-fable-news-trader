-- 011_simplify.sql — drop tables owned by features removed in the 2026-07
-- simplification: options trading, advisory recommendation audits, candidate
-- universe selection, and the parked dedup/backlog/cursor work-in-progress
-- (migrations 009/010 live only on backup/pre-cleanup). IF EXISTS makes this
-- correct whether or not 009/010 ever ran locally. Dormant columns added by
-- earlier migrations (e.g. paper_runtime_sessions.options_used) are left in
-- place — SQLite has no conditional DROP COLUMN.
DROP TABLE IF EXISTS paper_option_trades;
DROP TABLE IF EXISTS paper_recommendation_audits;
DROP TABLE IF EXISTS paper_universe_selections;
DROP TABLE IF EXISTS paper_duplicate_suppression_audits;
DROP TABLE IF EXISTS paper_event_terminals;
DROP TABLE IF EXISTS paper_provider_cursors;
