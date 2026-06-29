-- 004_paper_runtime_research.sql - PAPER runtime/report/recommendation audit tables.
--
-- Additive storage only. No trading behavior is enabled here.

CREATE TABLE paper_option_trades (
  id                 INTEGER PRIMARY KEY,
  paper_trade_id     INTEGER REFERENCES paper_trades(id) ON DELETE SET NULL,
  news_event_id      INTEGER REFERENCES news_events(id) ON DELETE SET NULL,
  underlying         TEXT    NOT NULL,
  option_symbol      TEXT    NOT NULL,
  expiry             TEXT    NOT NULL,
  strike             REAL    NOT NULL,
  right              TEXT    NOT NULL CHECK (right IN ('call','put')),
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  premium_entry      REAL,
  notional_entry     REAL,
  premium_exit       REAL,
  notional_exit      REAL,
  strategy           TEXT    NOT NULL CHECK (strategy IN ('long_call','long_put')),
  strategy_rationale TEXT,
  exit_policy        TEXT    NOT NULL,
  exit_reason        TEXT,
  status             TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','canceled')),
  closed_at          TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_option_trades_symbol ON paper_option_trades (option_symbol);
CREATE INDEX idx_paper_option_trades_underlying ON paper_option_trades (underlying);
CREATE INDEX idx_paper_option_trades_event ON paper_option_trades (news_event_id);

CREATE TABLE paper_runtime_sessions (
  id                         INTEGER PRIMARY KEY,
  session_date               TEXT    NOT NULL,
  started_at                 TEXT    NOT NULL,
  ended_at                   TEXT,
  status                     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','interrupted','error')),
  cycles                     INTEGER NOT NULL DEFAULT 0,
  fresh_news_count           INTEGER NOT NULL DEFAULT 0,
  classification_count       INTEGER NOT NULL DEFAULT 0,
  classification_status_json TEXT,
  skipped_reason_json        TEXT,
  rejected_reason_json       TEXT,
  orders_submitted           INTEGER NOT NULL DEFAULT 0,
  order_status_json          TEXT,
  model_request_count        INTEGER NOT NULL DEFAULT 0,
  shorts_used                INTEGER NOT NULL DEFAULT 0,
  options_used               INTEGER NOT NULL DEFAULT 0,
  margin_used                INTEGER NOT NULL DEFAULT 0,
  eod_report_status          TEXT,
  eod_report_error           TEXT,
  eod_report_sent_at         TEXT,
  created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_runtime_sessions_date ON paper_runtime_sessions (session_date);

CREATE TABLE paper_recommendation_audits (
  id                    INTEGER PRIMARY KEY,
  version               TEXT    NOT NULL,
  kind                  TEXT    NOT NULL,
  evidence_window_start TEXT,
  evidence_window_end   TEXT,
  sample_size           INTEGER NOT NULL DEFAULT 0,
  data_quality          TEXT    NOT NULL,
  observations_json     TEXT    NOT NULL,
  recommendations_json  TEXT    NOT NULL,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_recommendation_audits_kind ON paper_recommendation_audits (kind);

CREATE TABLE paper_universe_selections (
  id             INTEGER PRIMARY KEY,
  cycle_at       TEXT    NOT NULL,
  symbol         TEXT    NOT NULL,
  selected       INTEGER NOT NULL CHECK (selected IN (0,1)),
  rank_score     REAL,
  reasons_json   TEXT    NOT NULL,
  skipped_reason TEXT,
  source         TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_paper_universe_selections_cycle ON paper_universe_selections (cycle_at);
CREATE INDEX idx_paper_universe_selections_symbol ON paper_universe_selections (symbol);
