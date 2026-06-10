-- 003_price_reactions_event_study.sql — Phase 4 event-study storage.
--
-- Rebuilds price_reactions per docs/event-study-plan.md §6. A rebuild
-- (create new, drop old, rename) is safe because the table has never been
-- written to, and is required because SQLite cannot relax NOT NULL via
-- ALTER (the old baseline/reaction/return columns were NOT NULL, which made
-- unavailable prices unrepresentable).
--
-- Grain: one row per (news_event_id, horizon) — kept from the original
-- design. Windows anchor at news_events.received_at (recorded in anchor_at)
-- to avoid look-ahead bias. Non-'measured' rows carry NULL prices/returns:
-- failures are data (same principle as sentiment parser_status).
--
-- Timestamps: UTC ISO-8601 TEXT, as everywhere in this project.

CREATE TABLE price_reactions_new (
  id                 INTEGER PRIMARY KEY,
  news_event_id      INTEGER NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  horizon            TEXT    NOT NULL CHECK (horizon IN ('10s','1m','5m','30m','1h','eod')),
  measurement_status TEXT    NOT NULL CHECK (measurement_status IN
                       ('measured','no_baseline','no_reaction','market_closed','source_error')),
  anchor_at          TEXT    NOT NULL,  -- UTC ISO; = news_events.received_at
  baseline_at        TEXT,              -- timestamp of the baseline trade
  baseline_price     REAL    CHECK (baseline_price IS NULL OR baseline_price > 0),
  reaction_price     REAL    CHECK (reaction_price IS NULL OR reaction_price > 0),
  return_pct         REAL,              -- (reaction - baseline) / baseline
  high_price         REAL,              -- intra-horizon high
  low_price          REAL,              -- intra-horizon low
  volume             REAL,
  price_source       TEXT,              -- e.g. 'fixture', 'alpaca', 'polygon'
  measured_at        TEXT    NOT NULL,  -- UTC ISO when measurement completed
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (news_event_id, horizon)
);

DROP TABLE price_reactions;
ALTER TABLE price_reactions_new RENAME TO price_reactions;

CREATE INDEX idx_price_reactions_event ON price_reactions (news_event_id);
CREATE INDEX idx_price_reactions_status ON price_reactions (measurement_status);
