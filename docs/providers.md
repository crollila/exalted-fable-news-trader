# News Provider Adapters

How ExaltedFable ingests news without being hard-coded to any single source.

## Purpose

Every news source (Alpaca, Benzinga, Alpha Vantage, Polygon/Massive, future
providers) has its own field names, timestamp formats, and quirks. The
provider abstraction confines those differences to one small adapter file per
source. Everything downstream - persistence, event study, sentiment,
reporting - sees exactly one canonical event shape and never a provider-specific
field.

## The canonical path

```text
raw provider item
  -> adapter's normalizeProviderItem()        (field mapping only)
  -> normalizeNewsEvent()                     (src/providers/normalize.js)
  -> NormalizedNewsEvent                      (contract in src/providers/newsProvider.js)
  -> ingestNews()                             (src/ingestion/ingestNews.js)
  -> insertNewsEvent()                        (src/database/newsEvents.js)
  -> news_events row, deduped by (provider, provider_event_id)
```

Shared rules live in `normalizeNewsEvent()` and only there: required
provider/headline, UTC ISO-8601 timestamps, uppercase deduped symbols, ticker
derived from the first symbol when absent, stringified provider event ids, and
original payload preserved untouched in `raw` (persisted as `raw_payload`).
Adapters do field mapping and nothing else.

`ingestNews(db, provider, fetchOptions)` returns
`{ provider, fetched, inserted, duplicates, failed, insertedIds, errors }`.
Duplicates are counted, never re-inserted; a bad event is recorded in `errors`
without aborting the batch. Dedup is scoped by provider name, so the same id
from two providers stores as two events.

## The Injected-Transport Pattern

Each adapter is a factory taking an injected transport:

```js
const provider = createAlpacaNewsProvider({
  fetchRawNews: async (options) => [...rawItems],
});
```

By default no transport is configured and `fetchNews()` rejects with
`no transport configured`. This is deliberate: an adapter skeleton is
structurally incapable of making network calls or needing API keys. Tests inject
fixture-backed stubs.

Real HTTP clients are separate explicit transports, constructed only by manual
scripts when central config says the provider is configured. The registry test
(`tests/providerRegistry.test.js`) verifies every adapter rejects by default
while a fetch stub proves zero network attempts.

## Current Providers

| Name | Factory | Notes |
| --- | --- | --- |
| `mock` | `createMockProvider` | In-memory items, supports symbol/since/until/limit filtering |
| `alpaca` | `createAlpacaNewsProvider` | v1beta1 shape; dedicated numeric id; optional explicit HTTP transport |
| `benzinga` | `createBenzingaNewsProvider` | RFC-2822 timestamps; object-wrapped stocks/channels; optional explicit HTTP transport |
| `alpha_vantage` | `createAlphaVantageNewsProvider` | No dedicated id; derived from article URL; compact timestamps |
| `polygon` | `createPolygonNewsProvider` | String hash ids; `published_utc` already ISO; insights in raw |

All factories are exported from `src/providers/index.js`; the registry test
fails if one goes missing or a name changes.

## Real Transport Notes

Adapters remain fixture/transport-injection only by default. Real Alpaca and
Benzinga HTTP transports are explicit opt-in collaborators used by manual
scripts, with fake HTTP in tests.

API keys are read only by central config. Transports receive config objects;
they never read `process.env` directly.

Alpaca News uses headers `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`.

Benzinga News uses `GET https://api.benzinga.com/api/v2/news`. The official
Benzinga authentication documentation recommends header authentication for
production so keys do not appear in URL logs; the transport sends
`Authorization: token <key>` and never appends `token` to the request URL. It
maps the shared fetch options to `tickers`, `publishedSince`, `dateTo`,
`pageSize`, `displayOutput=full`, and `sort=created:desc`.

## Durable Per-Provider Cursors and Bounded Pagination

Each provider keeps a durable, sanitized watermark in `paper_provider_cursors`
(`cursor_value` is a published-time UTC ISO timestamp — never a URL, key,
headline, or payload). The runtime resolves each provider's fetch `since` from
its own cursor, floored by the lookback window so a long outage never triggers an
unbounded historical backfill (`resolveProviderSince`). The cursor advances to
the newest `published_at` actually persisted, and only after a successful,
fully-paginated, persisted response (`advanceProviderCursor`); a failed,
malformed, rate-limited, timed-out, or cooled-down attempt retains the prior
cursor (`retainProviderCursor`). Dedup on `(provider, provider_event_id)` makes a
small boundary re-fetch harmless, and the watermark never moves backwards.

Delta parameters:

- **Alpaca**: `start` bounds the fetch; pagination follows `next_page_token`
  (`page_token`) with `sort=asc`.
- **Benzinga**: `publishedSince` is the documented published-time delta;
  pagination uses `page`/`pageSize` with `sort=created:asc`.

Pagination is bounded by `provider_max_pages_per_cycle` (default 3). Both
transports sort ascending so that a *truncated* run (page bound reached with more
pages available) advances the cursor to what was persisted and resumes safely
next cycle rather than skipping older items. Without a `maxPages` option the
transports remain a single one-shot GET (legacy behavior for tests/fixtures).

## Durable Backlog Pipeline

Newly ingested events enter a durable pending pipeline whose eligibility is
derived from the database each cycle, so events beyond the per-cycle
classify/attempt caps carry forward until they reach a terminal state or age out.
Terminal state is distinguishable and durable:

| Terminal state | Durable source |
| --- | --- |
| submitted / pending / filled | `paper_trades` |
| signal-rejected / risk-rejected | `rejected_trades` (reason distinguishes) |
| duplicate-suppressed | `paper_duplicate_suppression_audits` |
| stale-expired | `paper_event_terminals` (`stale_expired`) |
| provider-invalid / unusable score | `paper_event_terminals` (`provider_invalid`) |

Events older than `max_queue_age_minutes` (default 120) that never reached a
terminal decision are swept to a durable `stale_expired` terminal with a
persisted sanitized reason. Successfully submitted events and terminal
signal/risk rejections are never retried. The console cycle report and the EOD
report both surface the backlog counters separately: carried-forward, newly
inserted, classified, proposal-eligible, attempted, deferred (classify cap),
deferred (attempt cap), stale-expired, provider-invalid, terminal rejections,
duplicate suppressions, and submitted.

## Duplicate Suppression

Provider-level ingestion dedup remains `(provider, provider_event_id)`.
Cross-provider trade-signal duplicate suppression is separate PAPER runtime
audit data. It does not collapse or delete `news_events` rows.

The PAPER loop builds a deterministic same-story identity from sanitized fields:
primary ticker, actionable model direction, a normalized headline fingerprint
hash, and a bounded published-time bucket. The audit table stores provider ids,
event ids, the identity hash/summary, window size, and a suppression reason. It
never stores raw headlines, raw payloads, provider responses, credentials,
headers, or request URLs.

Provider-supplied sentiment (Alpha Vantage scores, Polygon insights) stays in
`raw_payload` only; nothing writes it to `sentiment_scores`. ExaltedFable's own
sentiment/classification engine remains the only writer to `sentiment_scores`.

## Adding A Provider

1. Create `src/providers/<name>NewsProvider.js` following the existing pattern:
   factory, injected `fetchRawNews`, throwing default, and a
   `normalizeProviderItem` that maps fields into `normalizeNewsEvent()`.
2. Export it from `src/providers/index.js`.
3. Add static fixtures in `tests/fixtures/` and a fixture test file.
4. Add one entry to `PROVIDER_REGISTRY` in
   `tests/helpers/providerTestHelpers.js`; every registry-wide test then covers
   it automatically.
