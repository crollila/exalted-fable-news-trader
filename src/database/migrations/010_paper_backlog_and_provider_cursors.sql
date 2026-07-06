-- 010_paper_backlog_and_provider_cursors.sql - Durable PAPER backlog pipeline
-- terminal dispositions + per-provider ingestion cursors.
--
-- ADDITIVE ONLY. No trading behavior changes. Stores only sanitized lifecycle
-- bookkeeping: it never stores raw headlines, raw payloads, provider responses,
-- credentials, headers, request URLs, or query strings.
--
-- Why these tables:
-- - Newly ingested events enter a durable pending pipeline. Their terminal
--   state is derived from existing tables where one already exists
--   (paper_trades = submitted/pending, rejected_trades = signal/risk rejected,
--   paper_duplicate_suppression_audits = duplicate-suppressed). The TWO terminal
--   dispositions with no prior home -- stale_expired and provider_invalid -- get
--   an explicit, distinguishable, durable record here so aged-out / unusable
--   events are never re-selected and their reason is persisted.
-- - Per-provider cursors persist a sanitized published-time watermark so delta
--   fetches (Alpaca `start`, Benzinga `publishedSince`) resume safely and only
--   advance after a successful, fully-paginated, persisted response.

CREATE TABLE paper_event_terminals (
  id                INTEGER PRIMARY KEY,
  news_event_id     INTEGER NOT NULL UNIQUE REFERENCES news_events(id) ON DELETE CASCADE,
  provider          TEXT,
  terminal_state    TEXT    NOT NULL CHECK (terminal_state IN ('stale_expired','provider_invalid')),
  prompt_version    TEXT,
  queue_age_minutes INTEGER,
  reason            TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_event_terminals_state ON paper_event_terminals (terminal_state);
CREATE INDEX idx_paper_event_terminals_created ON paper_event_terminals (created_at);

CREATE TABLE paper_provider_cursors (
  id                INTEGER PRIMARY KEY,
  provider          TEXT    NOT NULL UNIQUE,
  cursor_kind       TEXT    NOT NULL DEFAULT 'published_watermark',
  cursor_value      TEXT,                       -- UTC ISO watermark (max published_at persisted)
  last_status       TEXT,                       -- ok | empty | truncated | failed | rate_limited | cooldown | disabled | unavailable
  last_pages        INTEGER NOT NULL DEFAULT 0,
  last_truncated    INTEGER NOT NULL DEFAULT 0 CHECK (last_truncated IN (0,1)),
  last_advanced_at  TEXT,
  last_attempted_at TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Per-session aggregate of the durable-backlog counters, for the EOD report.
ALTER TABLE paper_runtime_sessions ADD COLUMN backlog_counts_json TEXT;
