# Phase 3 Plan — Sentiment & Classification

Design document only. Nothing here is implemented by this document, and no
model calls, schema migrations, or dependencies are introduced by it.

## 1. Purpose

Phase 3 scores and classifies every normalized news event with ExaltedFable's
own engine. The output exists for **measurement first**: the event study
(Phase 4) needs a news type, a sentiment/impact score, and a confidence for
every event so expectancy can be sliced by type, score bucket, provider, and
time. Nothing in Phase 3 trades. A score is a hypothesis to be tested against
measured price reactions, not a signal to act on.

## 2. Inputs

The engine consumes canonical normalized events from the existing provider
abstraction (see `docs/providers.md`) — never raw provider items. Relevant
fields: `provider`, `provider_event_id`, `ticker`/`symbols`, `headline`,
`summary`/`body`, `published_at`, `received_at`, and `raw_payload`.

Provider-supplied sentiment (Alpha Vantage scores, Polygon insights) stays in
`raw_payload` as provider metadata. It must not be blindly trusted as our own
model score and must not be written to `sentiment_scores`. It may later serve
as a comparison baseline in research ("does our score beat the provider's?"),
which is exactly why the two must never be mixed in one column.

## 3. Proposed news type taxonomy (v1)

- `earnings`
- `guidance`
- `merger_acquisition`
- `analyst_rating`
- `fda_regulatory`
- `legal_lawsuit`
- `management_change`
- `financing_offering`
- `contract_partnership`
- `product_launch`
- `macro_sector`
- `unusual_market_activity`
- `other`

The taxonomy is versioned alongside the prompt version. It is expected to be
revised after event-study evidence shows which types carry edge and which
should be split or merged; revisions create a new version rather than
silently redefining existing labels.

## 4. Proposed scoring output schema (design only)

Intended classifier output per event:

| Field                | Type     | Notes                                                |
| -------------------- | -------- | ---------------------------------------------------- |
| `prompt_version`     | string   | required, e.g. `sentiment_v1`                        |
| `model_name`         | string   | required, e.g. `gpt-4o-mini`, `claude-haiku`         |
| `news_type`          | string   | one of the taxonomy values                           |
| `sentiment_score`    | number   | -1.0 .. +1.0                                         |
| `impact_score`       | number   | 0.0 .. 1.0, expected magnitude of reaction           |
| `confidence`         | number   | 0.0 .. 1.0, model's own certainty                    |
| `time_horizon`       | string   | e.g. `intraday`, `multiday`, `long_term`             |
| `direction`          | string   | `up`, `down`, `unclear`                              |
| `affected_symbols`   | string[] | tickers the model believes are affected              |
| `rationale`          | string   | short model explanation, for audit                   |
| `parser_status`      | string   | see section 6                                        |
| `raw_model_response` | string   | full unmodified model output, always stored          |

This is design only. The existing `sentiment_scores` table is not altered by
this document; gaps are listed in section 7 as future work.

## 5. Prompt versioning

Backtests are only reproducible if every score can be traced to the exact
prompt that produced it. Mixing scores from different prompts in one analysis
silently invalidates comparisons — a "better" expectancy may just be a
different prompt.

- Naming: `sentiment_v1`, `sentiment_v2`, ... (taxonomy revisions bump the
  version too).
- The full prompt text for each version must be stored in the repo or
  reproducibly referenced, so any historical score can be regenerated.
- Research queries must group or filter by `prompt_version`; results from
  different versions are never pooled without explicit grouping.

## 6. Malformed output / fallback handling

`parser_status` values:

- `parsed` — valid output, all required fields present and in range
- `malformed_json` — model output was not parseable JSON
- `missing_required_field` — JSON parsed but a required field is absent
- `invalid_score_range` — a score fell outside its defined range
- `model_error` — the model call itself failed (timeout, refusal, API error)
- `fallback_used` — a defined fallback value was substituted

Principles: malformed responses are **stored, not discarded** — the raw
response is kept with its failure status so parser bugs and model drift are
measurable. A failed classification must never block news ingestion or event
logging; the event row exists regardless, and scoring can be retried later.

## 7. Storage plan (mapping to the existing table)

The existing `sentiment_scores` table already covers: `news_event_id`,
`model` (→ model_name), `prompt_version`, `sentiment_score`, `news_type`,
`confidence`, `raw_response` (→ raw_model_response), `parse_ok`, `created_at`.

Gaps to revisit later (future work, **no migration in this task**):

- `impact_score`, `time_horizon`, `direction`, `affected_symbols`,
  `rationale` have no columns; either add columns in a reviewed Phase 3
  migration or store as a JSON detail column.
- `parse_ok` is a boolean; the richer `parser_status` enum would replace or
  accompany it in a reviewed migration.

## 8. Testing plan (future implementation)

- Deterministic fixture classifier: a fake classifier returning canned
  outputs, so the whole pipeline is testable with zero model calls.
- Parser accepts valid model JSON and produces the full output schema.
- Parser rejects malformed JSON safely and labels it `malformed_json`.
- Score ranges validated; out-of-range values become `invalid_score_range`.
- Classifier failure does not abort ingestion or event logging.
- `prompt_version` is required; absence is a hard error in tests.
- Raw model response is preserved byte-for-byte in all cases.

## 9. Explicit non-goals of this task

- No implementation.
- No model calls.
- No OpenAI/Anthropic/API integration.
- No real provider calls.
- No trading logic.
- No schema migration unless separately approved.
- No dependencies.

## 10. Recommended next implementation step

The smallest safe Phase 3 step: **a fixture-only classifier contract and
parser with tests** — define the classifier interface (mirroring the
injected-transport pattern providers use), implement the output parser and
validation against fixture model responses (valid and malformed), and prove
failures don't block ingestion. No model calls, no dependencies, no schema
changes.
