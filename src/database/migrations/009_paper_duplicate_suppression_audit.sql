-- 009_paper_duplicate_suppression_audit.sql - Cross-provider same-story audit.
--
-- ADDITIVE ONLY. Stores sanitized explanations when a provider story is
-- suppressed as equivalent to another provider's story for PAPER signal
-- attempts. It never stores raw headlines, raw payloads, provider responses,
-- credentials, headers, or request URLs.

CREATE TABLE paper_duplicate_suppression_audits (
  id                           INTEGER PRIMARY KEY,
  suppressed_news_event_id     INTEGER NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  suppressed_provider          TEXT    NOT NULL,
  suppressed_provider_event_id TEXT,
  kept_news_event_id           INTEGER NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  kept_provider                TEXT    NOT NULL,
  kept_provider_event_id       TEXT,
  signal_identity_hash         TEXT    NOT NULL,
  identity_summary             TEXT    NOT NULL,
  duplicate_window_minutes     INTEGER NOT NULL,
  reason                       TEXT    NOT NULL,
  created_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_duplicate_suppression_created
  ON paper_duplicate_suppression_audits (created_at);
CREATE INDEX idx_paper_duplicate_suppression_suppressed
  ON paper_duplicate_suppression_audits (suppressed_news_event_id);
CREATE INDEX idx_paper_duplicate_suppression_kept
  ON paper_duplicate_suppression_audits (kept_news_event_id);

ALTER TABLE paper_runtime_sessions ADD COLUMN provider_status_json TEXT;
ALTER TABLE paper_runtime_sessions ADD COLUMN provider_counts_json TEXT;
ALTER TABLE paper_runtime_sessions ADD COLUMN batch_counts_json TEXT;
