# Market-Data Client Plan — First Real PriceSource

Design/review document only. Nothing here is implemented by this document.
Implementation requires separate explicit approval, mirroring how the
Alpaca News transport was planned (docs/real-data-tier-plan.md) before it
was built.

## 1. Why now

Real Alpaca News events now exist in news_events (manual one-shot ingest,
dedup proven against live data). That satisfies the precondition the
real-data tier plan set for Option B: real prices finally have real events
to measure. The fixture tier already proves the full measurement loop
(fixture PriceSource → measureEvent → price_reactions), so the only
missing piece is a real client behind the same contract.

## 2. What PriceSource currently expects (the contract is frozen)

From src/prices/priceSource.js:

- `name` — non-empty string, stored in `price_reactions.price_source`.
- `getTradesAround(ticker, fromIso, toIso)` — resolves to an array of
  `Trade { price > 0, at: UTC ISO-8601 string, size? }`, **ascending by
  time**, every `at` within `[fromIso, toIso]` inclusive, and `[]` when
  the source has no data for the window.

From src/eventStudy/measureReactions.js, the engine additionally assumes:

- ONE call covers all horizons: `[anchor − lookback, max horizon target]`.
- Timestamps are compared **lexicographically as strings**, so every `at`
  must be a fixed-width `YYYY-MM-DDTHH:MM:SS.mmmZ` UTC ISO string (the
  format the rest of the project already uses). A real client must
  normalize provider timestamps to exactly this shape.
- A thrown error from `getTradesAround` → ALL requested horizons stored
  as `source_error` (observable, never fatal).
- `[]` or no pre-anchor trade → `no_baseline`; baseline but no post-anchor
  trade in a window → `no_reaction`.

The real client must change NOTHING here: it is a data faucet behind the
existing interface. All measurement semantics stay in the engine.

## 3. Candidate first providers

| Candidate          | Trades endpoint? | Keys we already have? | Free-tier reality                                    |
| ------------------ | ---------------- | --------------------- | ---------------------------------------------------- |
| Alpaca Market Data | Yes — historical trades (ticks) | YES — same key pair as the news transport | IEX feed on the free/basic plan; consolidated SIP requires a paid plan; per-minute rate limit |
| Polygon/Massive    | Yes — trades (ticks) | No key yet         | Free tier is heavily rate-limited (≈5 req/min) and delayed; tick access limited |
| Alpha Vantage      | NO — intraday OHLC bars only | No key yet   | Cannot satisfy getTradesAround at all (bars ≠ trades); ~25 req/day |
| Yahoo/other free   | No supported trade-tick API | —          | Bars/quotes only; unofficial endpoints are unstable  |

Exact current rate limits and feed entitlements must be re-verified
against Alpaca's docs at implementation time, not assumed from this plan.

## 4. Recommendation: Alpaca Market Data (historical trades), IEX feed

Reasons, in order:

1. **Keys already exist.** The same ALPACA_API_KEY_ID/SECRET pair used by
   the proven news transport works for market data — zero new secrets,
   zero new .env names, the existing config.alpacaNews plumbing pattern
   reuses cleanly (see §11 for naming).
2. **It returns actual trades**, which is what the contract and the
   already-built measurement engine consume. Bar-only providers would
   force a contract change or a lossy bars→pseudo-trades shim — both
   rejected.
3. **Same vendor, same auth style, same error shapes** as the news
   transport, so the sanitization/redaction code pattern is already
   proven in this repo.
4. **Known limitation accepted:** the free IEX feed is a subset of
   consolidated tape volume. Thin coverage will produce more
   `no_baseline`/`no_reaction` rows for illiquid tickers — and that is
   acceptable BECAUSE failures are stored as data; the bias is visible
   and queryable, not silent. Upgrading to SIP later changes only the
   feed parameter, behind the same client.

Polygon remains the documented second source (the `price_source` column
exists precisely so sources can be compared row by row).

## 5. Mapping getTradesAround → Alpaca API

Endpoint (verify exact path/params at implementation):
`GET https://data.alpaca.markets/v2/stocks/{symbol}/trades`
with `start`/`end` (RFC-3339), `limit` (page size), `feed=iex`, and the
same `APCA-API-KEY-ID`/`APCA-API-SECRET-KEY` headers as the news
transport. Response: `{ trades: [{ t, p, s, ... }], next_page_token }`.

Field mapping (mapping layer only, like the news adapters):

- `t` → `at`: Alpaca returns RFC-3339 with nanosecond precision;
  truncate/normalize to millisecond `YYYY-MM-DDTHH:MM:SS.mmmZ` so string
  comparison in the engine stays correct.
- `p` → `price` (must be > 0 or the item is dropped as malformed).
- `s` → `size` (optional passthrough).
- Items already arrive time-ascending; the client still sorts
  defensively before returning (cheap, guarantees the contract).
- `ticker` is uppercased/trimmed before the request, mirroring the news
  transport.

**Pagination (differs from the news transport, deliberately).** The news
transport is single-page because a partial news list is still useful. A
partial TRADE window is NOT: a missing chunk of trades silently corrupts
reaction/high/low/volume. Therefore the price client follows
`next_page_token` up to a hard page cap (e.g. 10 pages). If the cap is
exceeded, it THROWS a sanitized "window too large" error — the engine
stores `source_error`, which is honest, rather than returning a
truncated window, which would be a wrong `measured` row.

## 6. Time windows and UTC

- Inputs `fromIso`/`toIso` pass through as `start`/`end` after
  `new Date(x).toISOString()` normalization (same as the news transport).
- Everything is UTC end to end; no local-time math anywhere in the client.
- The client never widens the requested window and never returns trades
  outside `[fromIso, toIso]` (inclusive bounds filtered after mapping) —
  this is part of the look-ahead guarantee (§9).
- Clock-skew note: `anchor_at` (= received_at) is stamped by OUR machine;
  trade timestamps come from the exchange/Alpaca. Sub-second skew is
  possible and tolerable at current horizons (min 10s); recorded here so
  nobody treats 10s-horizon results as microstructure-grade.

## 7. Failure handling (client side) and measurement_status (engine side)

The split is strict: the client either returns a correct trade array or
throws a sanitized error. It never invents statuses. The engine's
existing mapping then applies unchanged:

| Condition at the client                       | Client behavior                       | Resulting status (engine, unchanged) |
| --------------------------------------------- | ------------------------------------- | ------------------------------------ |
| Trades found                                  | return mapped ascending Trade[]       | `measured` / `no_reaction` per window |
| Zero trades in window (thin feed, halt, closed market) | return `[]`                  | `no_baseline`                        |
| Trades only before anchor                     | return them                           | `no_reaction`                        |
| HTTP 429 (rate limit)                         | throw sanitized `HTTP 429` error — NO retry loops in v1 | `source_error` |
| HTTP 401/403 (auth)                           | throw sanitized `HTTP 401/403` error; never echo keys/headers | `source_error` |
| Other HTTP errors                             | throw `HTTP <status> <redacted statusText>` | `source_error`              |
| Network failure                               | throw redacted `request failed: <message>` | `source_error`               |
| Malformed JSON / unexpected payload shape     | throw static-text error               | `source_error`                       |
| Malformed item (missing t/p, p <= 0)          | drop the item; if ALL items malformed, throw | `source_error` (or thin-window statuses) |
| Page cap exceeded (§5)                        | throw "window too large" error        | `source_error`                       |

`market_closed` is NOT emitted in this step (see §8). All five canonical
statuses remain valid schema values; the engine's behavior for the four
it can currently produce is untouched.

## 8. market_closed and EOD: explicitly deferred

- **market_closed** requires a session calendar (trading days, half-days,
  DST). Step 1 ships WITHOUT it: an event received at 02:00 UTC Sunday
  will store `no_baseline` (no trades in the lookback), which is true and
  queryable, just less specific than `market_closed`. The upgrade path —
  Alpaca's calendar endpoint feeding a session-aware policy that the
  ENGINE (not the client) applies before calling the source — is its own
  later reviewed task, because it changes measurement semantics.
- **EOD** keeps the temporary fixture policy (same UTC day 21:00:00.000Z)
  in step 1, with its existing documented caveat. Real EOD (official
  session close per the calendar) lands together with the market_closed
  task, since both need the same calendar. Until then, eod-horizon rows
  from the real source are usable but carry the placeholder-policy caveat;
  analysis that cares should filter to intraday horizons.

## 9. Look-ahead bias guarantees

- The anchor stays `news_events.received_at`, set by the ingest path —
  the client never sees or influences it.
- The engine computes the window; the client only honors it. No trades
  outside `[fromIso, toIso]` are ever returned (§6), so the baseline can
  never come from after-the-fact data.
- Reaction selection ("strictly after anchor") lives in the engine and is
  untouched by this step.

## 10. No-secret logging / error rules (same regime as the news transport)

- Keys live only in request headers; never in URLs, never logged, never
  thrown, never persisted, never returned.
- Error messages are static text + status codes, passed through the same
  `redact()` defensive pattern (any accidental key occurrence replaced).
- Raw error objects from fetch are never rethrown or logged (they can
  embed request config); only sanitized messages propagate.
- Trade payloads are public market data and may be returned/stored, but
  request objects are never stored or logged.
- A test must assert the thrown-error paths never contain the key strings.

## 11. Config and keys

- Reuse the existing key pair via config: add `config.alpacaMarketData`
  (same env names ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY — no new .env
  entries, no .env edits) OR read `config.alpacaNews` directly. Decision
  for the implementation review: a separate config alias keeps the
  news/market-data split visible; either way, NOTHING reads process.env
  outside src/config.js.
- Construction throws "not configured" without keys — identical
  disabled-by-default behavior to the news transport. No auto-wiring, no
  "if key present, go live".

## 12. Free-tier / rate-limit considerations

- One measured event = ONE getTradesAround call (the engine already
  batches all horizons into a single window). A capped manual run of 5
  events ≈ 5 requests plus pagination — far inside any per-minute limit.
- No retry/backoff logic in v1: a 429 becomes a visible `source_error`
  row, and the manual runner is invoked by a human who can rerun.
  Re-measurement is already idempotent (replace-on-remeasure), so reruns
  are safe by construction.
- The IEX-feed coverage limitation is a data-quality fact recorded in
  `price_source` ('alpaca_iex' as the source name is recommended so a
  future SIP upgrade is distinguishable, e.g. 'alpaca_sip').
- Bulk/historical backfill measurement is OUT of scope until the news
  pagination/backfill step exists; rate-limit budgeting becomes a real
  design topic only then.

## 13. Test strategy (fake-HTTP only; npm test stays offline)

Mirror tests/alpacaHttpTransport.test.js with an injected `httpFetch`:

- success: mapping (t/p/s → at/price/size), ns→ms timestamp normalization,
  ascending order, inclusive-window filtering;
- pagination: follows next_page_token across fake pages, merges in order;
- page-cap exceeded → sanitized throw;
- HTTP 429 / 401 / 500 → sanitized throws, key strings absent (redaction
  test identical in spirit to the news transport's);
- network failure → redacted "request failed" throw;
- malformed JSON and unexpected payload shape → clear throws;
- zero trades → resolves `[]`;
- not-configured construction → throws before any HTTP;
- integration (fixture-level): measureEvent with a fake-HTTP-backed real
  client produces the same rows as the fixture source given identical
  trades — proving the client is semantics-neutral.
- NO live-network tests in npm test; no credentials needed by the suite.

## 14. Manual live smoke check (separate later task, pattern proven twice)

`scripts/smokeAlpacaTrades.js` — manual-only, CLI-guarded, never in npm
test: fetch trades for one symbol over one tiny recent window (e.g. 5
minutes, capped), print sanitized output only (count, first/last trade
timestamps, min/max price — prices are public data; never keys, headers,
request URLs, or raw payloads). PASS = transport reachable + payload
normalized, exactly like the news smoke check.

## 15. Manual one-shot measurement run (separate later task)

`scripts/measureReactionsOnce.js` — manual-only, CLI-guarded: select a
tiny capped set of EXISTING news_events rows (e.g. --limit 3, hard cap
10, optionally --ids), construct the real client explicitly, run the
existing measureEvents batch helper, and print a sanitized summary
(per-event per-horizon statuses, counts by status, replaced flags — no
raw payloads). Writes go ONLY through insertPriceReaction (idempotent
replace). Expected first-run reality check: our 5 stored AAPL events were
ingested at one wall-clock moment, so several horizons may land outside
market hours and store no_baseline/no_reaction — that outcome is correct
and is itself the proof that failures-as-data works on real data.

## 16. Sequencing (each its own reviewed task)

1. THIS DOC — design review only.
2. Real client implementation behind PriceSource + fake-HTTP tests
   (src/prices/alpacaTradesHttpClient.js or similar; no script yet).
3. Manual trades smoke check script + README/STATUS updates.
4. Manual one-shot measurement script over existing events + docs.
5. (Later, semantics-changing, bigger review) session calendar:
   market_closed policy + real EOD definition.

## 17. Explicitly out of scope for this task

- NO implementation of any kind in this task (design doc only).
- NO live market-data calls in npm test, ever.
- NO polling, scheduling, or background jobs.
- NO model calls; NO sentiment/classification changes.
- NO trading logic, paper orders, or risk-engine changes.
- NO new dependencies unless separately approved (built-in fetch should
  suffice, as it did for the news transport).
- NO .env edits; NO new secret names.
- NO database/schema changes unless separately approved (none are
  expected: price_reactions already fits).
