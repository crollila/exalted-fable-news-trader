-- 007_paper_equity_sizing_decisions.sql - PAPER equity sizing audit records.
--
-- ADDITIVE ONLY. This stores sanitized, immutable sizing decisions for PAPER
-- equity proposals. It never enables live trading and never stores raw model
-- responses, headlines, secrets, or request objects.

CREATE TABLE paper_equity_sizing_decisions (
  id                         INTEGER PRIMARY KEY,
  paper_trade_id             INTEGER REFERENCES paper_trades(id) ON DELETE SET NULL,
  rejected_trade_id          INTEGER REFERENCES rejected_trades(id) ON DELETE SET NULL,
  news_event_id              INTEGER REFERENCES news_events(id) ON DELETE SET NULL,
  ticker                     TEXT    NOT NULL,
  side                       TEXT    NOT NULL CHECK (side IN ('buy','sell')),
  manual_override            INTEGER NOT NULL DEFAULT 0 CHECK (manual_override IN (0,1)),
  sizing_mode                TEXT    NOT NULL CHECK (sizing_mode IN ('cold_start','evidence_weighted','abstain')),
  evidence_tier              TEXT,
  evidence_count             INTEGER NOT NULL DEFAULT 0,
  evidence_quality           TEXT    NOT NULL,
  model                      TEXT,
  prompt_version             TEXT,
  news_type                  TEXT,
  direction                  TEXT,
  score_bucket               TEXT,
  requested_target_weight    REAL,
  requested_notional         REAL,
  requested_quantity         INTEGER,
  approved_target_weight     REAL,
  approved_notional          REAL,
  approved_quantity          INTEGER,
  reference_price            REAL,
  account_equity             REAL,
  current_owned_exposure     REAL,
  risk_approved              INTEGER CHECK (risk_approved IN (0,1)),
  risk_reason                TEXT,
  explanation                TEXT    NOT NULL,
  warnings_json              TEXT    NOT NULL,
  created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_equity_sizing_decisions_created
  ON paper_equity_sizing_decisions (created_at);
CREATE INDEX idx_paper_equity_sizing_decisions_event
  ON paper_equity_sizing_decisions (news_event_id);
CREATE INDEX idx_paper_equity_sizing_decisions_mode
  ON paper_equity_sizing_decisions (sizing_mode);
