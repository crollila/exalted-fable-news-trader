# Sentiment Storage Plan — sentiment_scores Writer Mapping

Design document only. No migration or writer is implemented by this document.
Companion to `docs/sentiment-classification-plan.md` (§7 raised the gaps this
document resolves).

## 1. What the table stores today vs what the parser produces

`sentiment_scores` (001_initial.sql) vs `ClassificationResult` /
`ClassificationOutput` (src/sentiment/):

| Parser output        | Current column    | Status                            |
| -------------------- | ----------------- | --------------------------------- |
| `modelName`          | `model`           | OK                                |
| `promptVersion`      | `prompt_version`  | OK (NOT NULL — matches contract)  |
| `output.sentimentScore` | `sentiment_score` | OK                            |
| `output.newsType`    | `news_type`       | OK                                |
| `output.confidence`  | `confidence`      | OK                                |
| `rawModelResponse`   | `raw_response`    | OK                                |
| `parserStatus`       | `parse_ok` (bool) | **GAP** — boolean loses 6-way enum |
| `output.impactScore` | —                 | **GAP**                           |
| `output.direction`   | —                 | **GAP**                           |
| `output.timeHorizon` | —                 | **GAP**                           |
| `output.affectedSymbols` | —             | **GAP**                           |
| `output.rationale`   | —                 | **GAP**                           |
| `errors`             | —                 | **GAP**                           |

## 2. Decision: hybrid (recommended)

Add **explicit columns** for fields the event study will filter, bucket, or
group by; add **one JSON detail column** for audit-grade fields that research
reads per-row but never slices on.

New explicit columns (all nullable except parser_status):

- `parser_status TEXT NOT NULL` — the 6-value enum; CHECK constraint on the
  known values. `parse_ok` is kept and becomes derived convenience
  (`parser_status IN ('parsed','fallback_used')`), so existing rows and
  queries keep working; it can be dropped much later if it proves redundant.
- `impact_score REAL` — core event-study bucket dimension ("does high
  predicted impact correlate with larger reactions?").
- `direction TEXT` — core slice dimension ("was the model's direction right?").
- `time_horizon TEXT` — slice dimension for choosing measurement windows.

New JSON detail column:

- `detail TEXT` — JSON object holding `affected_symbols` (array),
  `rationale` (audit text), and `errors` (array of parser notes). None of
  these is a GROUP BY dimension: symbols-per-event is already answered by
  `news_events.ticker`/`symbols` for the primary instrument, rationale is
  human audit material, errors are diagnostics.

## 3. Why hybrid (tradeoffs considered)

**Event-study queries.** Expectancy slicing means SQL like
`GROUP BY news_type, direction, CAST(impact_score*10 AS INT)` filtered by
`parser_status = 'parsed'`. With explicit columns these are plain indexed
predicates. With JSON-only storage every such query needs `json_extract()` on
every row — slower, untyped, unindexable without generated columns, and easy
to typo silently (a misspelled JSON key returns NULL rather than erroring).
The slice dimensions must be real columns.

**All-columns alternative.** Promoting affected_symbols/rationale/errors to
columns forces an array into either a TEXT-JSON column anyway or a join
table neither research nor reporting currently needs. It adds schema churn
for fields with no query story. Rejected as overengineering now; any detail
field that later earns a query story gets promoted via a small reviewed
migration (or a generated column over `detail`).

**JSON-only alternative.** Maximum schema stability, but it taxes exactly the
queries this project exists to run, and weakens integrity: no CHECK on
parser_status, no REAL typing on impact_score. Rejected.

**Reproducibility.** Unaffected by the choice — `prompt_version`,
`raw_response`, and `parser_status` carry reproducibility, and all are
explicit columns under the hybrid. Storing `errors` in `detail` preserves
fallback context (which enum fell back and why) per plan §6.

**Schema stability.** SQLite `ALTER TABLE ... ADD COLUMN` is cheap, additive,
and safe for existing rows (new columns are NULL/defaulted). The hybrid needs
one small migration now and gives `detail` as a pressure valve so future
model-output extras don't each demand a migration.

**Future reporting.** Reports group by the same dimensions as the event
study; explicit columns serve them directly. Postgres portability is
preserved: `detail` maps to JSONB, everything else is standard SQL.

## 4. Planned migration (FUTURE WORK — not in this task)

`002_sentiment_scores_phase3.sql`, to be reviewed before implementation:

```sql
ALTER TABLE sentiment_scores ADD COLUMN parser_status TEXT
  CHECK (parser_status IN ('parsed','malformed_json','missing_required_field',
                           'invalid_score_range','model_error','fallback_used'));
ALTER TABLE sentiment_scores ADD COLUMN impact_score REAL;
ALTER TABLE sentiment_scores ADD COLUMN direction TEXT
  CHECK (direction IN ('up','down','unclear'));
ALTER TABLE sentiment_scores ADD COLUMN time_horizon TEXT;
ALTER TABLE sentiment_scores ADD COLUMN detail TEXT; -- JSON: affected_symbols, rationale, errors
CREATE INDEX idx_sentiment_scores_status ON sentiment_scores (parser_status);
```

Note: SQLite cannot add a NOT NULL column without a default to a non-empty
table; `parser_status` is therefore added nullable, with NOT NULL enforced by
the writer and revisited if the table is ever rebuilt.

## 5. Writer mapping (FUTURE WORK — design)

`insertSentimentScore(db, newsEventId, classificationResult)`:

- `model` ← `modelName`; `prompt_version` ← `promptVersion` (writer throws if
  missing — contract already guarantees presence)
- `parser_status` ← `parserStatus`; `parse_ok` ← derived boolean
- `sentiment_score`/`news_type`/`confidence`/`impact_score`/`direction`/
  `time_horizon` ← from `output` when present, else NULL (failed parses
  store a row with NULL scores — failures are data, per plan §6)
- `raw_response` ← `rawModelResponse` (always, byte-for-byte)
- `detail` ← JSON of `{ affected_symbols, rationale, errors }`
- Returns inserted row id; never blocks ingestion (separate stage, separate
  transaction).

## 6. Smallest safe next implementation step

One reviewed task: migration `002_sentiment_scores_phase3.sql` + the
`insertSentimentScore` writer + tests (migration idempotency on existing
data, full mapping round-trip for parsed/fallback/failed results, NULL score
handling, raw response preservation, writer rejects missing prompt_version,
writer failure does not abort ingestion). Fixture classifier results only —
still no model calls, no dependencies.
