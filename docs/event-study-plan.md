# Phase 4 Plan — Event Study (Price Reactions)

Design document only. No price fetching, schema migration, trading, or
strategy logic is implemented by this document.

## 1. Purpose

Phase 4 answers the project's core question: do AI-scored news events
predict price movement? It measures what actually happened to the price
after each event, at fixed horizons, and joins those measurements to the
scores so expectancy can be sliced by score bucket, news type, ticker,
provider, prompt_version, and time of day. Measurement comes before any
strategy decision — a score with no measured reaction is an untested
hypothesis.

## 2. Current schema vs Phase 4 needs

`price_reactions` (001_initial.sql) is already **one row per
(event, horizon)** with `UNIQUE (news_event_id, horizon)`, baseline/
reaction/return columns, intra-horizon high/low/volume, and `measured_at`.
That grain is correct and is kept (see §5). Gaps against BUILD_PLAN.md:

| Phase 4 need                          | Current state | Gap |
| ------------------------------------- | ------------- | --- |
| Horizons 10s, 1m, 5m, 30m, 1h, EOD    | free-text `horizon` (comment suggests '1d') | define canonical set + CHECK |
| Unavailable prices representable      | `baseline_price`/`reaction_price`/`return_pct` NOT NULL | impossible today |
| Measurement status                    | none          | add `measurement_status` |
| Window anchor recorded                | none          | add `anchor_at` (+ which timestamp anchored it) |
| Price source recorded                 | none          | add `price_source` |
| Event-time price                      | representable as baseline | define precisely (§4) |

## 3. Canonical horizons (v1)

`'10s', '1m', '5m', '30m', '1h', 'eod'` — stored lowercase, enforced by
CHECK. EOD means the official/last regular-session price of the anchor
day's session (defined precisely when the price source lands; the schema
just reserves the label). The horizon set is versioned with the analysis,
not silently extended.

## 4. Measurement flow design

**Anchor.** Every window anchors at `received_at` (when WE could first have
acted), recorded explicitly in `anchor_at`. `published_at` is kept for
latency analysis but does not anchor windows: measuring from publish time
would credit the system with reactions it could never have captured —
exactly the kind of look-ahead bias that fabricates edge.

**Baseline ("event-time price").** The last trade price at or immediately
before `anchor_at`, with its own timestamp (`baseline_at`) so staleness is
measurable. Reaction price per horizon: last trade at or before
`anchor_at + horizon`. `return_pct = (reaction - baseline) / baseline`.
Raw simple returns in v1; market/sector-adjusted (abnormal) returns are a
later, explicitly versioned refinement.

**Linkage to scores.** Through `news_event_id`: price_reactions and
sentiment_scores both FK to news_events. The canonical analysis join is
events × scores × reactions, **always grouped/filtered by
`prompt_version` and `model`** — measurements are score-agnostic facts
(measured once per event/horizon regardless of how many prompt versions
scored the event), so reactions are never duplicated per prompt and never
mixed across prompts at analysis time.

**Duplicate events.** Cross-provider duplicates measured separately would
double-count the same story. Rule: measurement targets one canonical event
per story. Until `dedup_group` is populated (still a Phase 2 leftover),
provider-level dedup already prevents same-provider duplicates; when
cross-provider grouping lands, the event study measures the earliest
`received_at` member of each group and analysis excludes non-canonical
members. The plan makes this a research-layer rule now and a `dedup_group`
join later — no schema change needed in price_reactions.

**Unavailable prices.** Halts, illiquid tickers, after-hours events, and
data-source gaps are normal, not exceptional. Each attempted measurement
stores a row with `measurement_status`:

- `measured` — baseline and reaction both found
- `no_baseline` — no usable price at/just before anchor
- `no_reaction` — baseline found, horizon price missing
- `market_closed` — window falls wholly outside trading hours (policy for
  these is part of the price-source step)
- `source_error` — price source failed

Non-`measured` rows carry NULL prices/returns. Failures are data (same
principle as parser_status): if reactions are missing systematically for
some ticker class, that bias must be visible, not silently absent.

**Event windows recorded.** Each row records `horizon`, `anchor_at`,
`baseline_at`, and `measured_at`, making every window reconstructible and
re-measurable (re-measurement replaces by `UNIQUE(news_event_id, horizon)`).

**Price sourcing (later).** The price source will follow the proven
injected-transport pattern: a `PriceSource` contract (e.g.
`getTradesAround(ticker, fromIso, toIso)`), fixture-backed first, real
Alpaca/Polygon market-data clients later behind the same interface.
`price_source` column records which source produced each row.

## 5. Decision: one row per (event, horizon) — keep the existing grain

**Rejected: wide row** (one row per event with baseline_10s/reaction_10s/
... columns). Every new horizon is a migration ×3 columns; per-horizon
status/high/low/volume multiply columns further; queries like "mean return
by horizon" require UNPIVOTing; partial measurement leaves ragged
half-empty rows.

**Kept: long/narrow rows.** Matches the existing schema, so Phase 4 needs
only additive/rebuild changes rather than a redesign:

- *Queryability:* `GROUP BY horizon` and per-horizon filtering are direct;
  the score join is identical for every horizon.
- *Schema stability:* a new horizon is a CHECK-list edit, not new columns.
- *Backtesting:* re-measurement and partial windows are row-level upserts;
  `measurement_status` per row keeps incomplete data first-class.
- *Reporting:* expectancy tables are natural pivots over (slice, horizon).
- *Postgres portability:* plain long-format SQL; no SQLite-specific tricks.

## 6. Planned migration 003 (FUTURE WORK — not in this task)

`price_reactions` has zero rows in any database, so a **rebuild** (create
new, drop old, rename) is safe and cleaner than fighting SQLite's
inability to relax NOT NULL via ALTER. Target shape:

```sql
CREATE TABLE price_reactions (
  id                 INTEGER PRIMARY KEY,
  news_event_id      INTEGER NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  horizon            TEXT    NOT NULL CHECK (horizon IN ('10s','1m','5m','30m','1h','eod')),
  measurement_status TEXT    NOT NULL CHECK (measurement_status IN
                       ('measured','no_baseline','no_reaction','market_closed','source_error')),
  anchor_at          TEXT    NOT NULL,  -- UTC ISO; = news_events.received_at
  baseline_at        TEXT,              -- timestamp of the baseline trade
  baseline_price     REAL,              -- NULL unless status='measured' (or no_reaction)
  reaction_price     REAL,
  return_pct         REAL,
  high_price         REAL,
  low_price          REAL,
  volume             REAL,
  price_source       TEXT,              -- e.g. 'fixture', 'alpaca', 'polygon'
  measured_at        TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (news_event_id, horizon)
);
```

## 7. Smallest safe next implementation step

One reviewed task, fixture-only, mirroring the Phase 3 sequence:
migration 003 (rebuild above) + a `PriceSource` contract with a fixture
price source (injected data, throwing default — no market-data API) + an
`insertPriceReaction` writer + tests (migration idempotency, all five
status outcomes stored, unavailable prices as NULL-price rows,
re-measurement replaces rather than duplicates, no network). Real price
transports come later as their own reviewed step.

## 8. Explicit non-goals of this task

No price API/client, no Alpaca/Polygon calls, no model calls, no trading
or paper orders, no risk-engine changes, no schema migration yet, no
dependencies.
