-- 002_sentiment_scores_phase3.sql — Phase 3 storage for classifier output.
--
-- Implements the hybrid design in docs/sentiment-storage-plan.md §4:
-- explicit columns for event-study query dimensions, one JSON detail column
-- for audit-grade fields (affected_symbols, rationale, errors).
--
-- All additions are additive ALTER TABLE ... ADD COLUMN: cheap in SQLite and
-- safe for existing rows (new columns are NULL). parser_status is nullable
-- at the schema level because SQLite cannot add a NOT NULL column without a
-- default to a populated table; the writer (src/database/sentimentScores.js)
-- enforces presence. parse_ok remains as derived convenience:
-- parser_status IN ('parsed','fallback_used').

ALTER TABLE sentiment_scores ADD COLUMN parser_status TEXT
  CHECK (parser_status IS NULL OR parser_status IN
    ('parsed','malformed_json','missing_required_field',
     'invalid_score_range','model_error','fallback_used'));

ALTER TABLE sentiment_scores ADD COLUMN impact_score REAL
  CHECK (impact_score IS NULL OR (impact_score >= 0.0 AND impact_score <= 1.0));

ALTER TABLE sentiment_scores ADD COLUMN direction TEXT
  CHECK (direction IS NULL OR direction IN ('up','down','unclear'));

ALTER TABLE sentiment_scores ADD COLUMN time_horizon TEXT
  CHECK (time_horizon IS NULL OR time_horizon IN ('intraday','multiday','long_term'));

-- JSON object: { affected_symbols: string[], rationale: string|null, errors: string[] }
ALTER TABLE sentiment_scores ADD COLUMN detail TEXT;

CREATE INDEX idx_sentiment_scores_status ON sentiment_scores (parser_status);
