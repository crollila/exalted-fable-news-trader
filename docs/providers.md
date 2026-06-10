# News Provider Adapters

How ExaltedFable ingests news without being hard-coded to any single source.

## Purpose

Every news source (Alpaca, Benzinga, Alpha Vantage, Polygon/Massive, future
providers) has its own field names, timestamp formats, and quirks. The
provider abstraction confines those differences to one small adapter file per
source. Everything downstream — persistence, event study, sentiment,
reporting — sees exactly one canonical event shape and never a
provider-specific field.

## The canonical path

```
raw provider item
  → adapter's normalizeProviderItem()        (field mapping only)
  → normalizeNewsEvent()                     (src/providers/normalize.js — all shared rules)
  → NormalizedNewsEvent                      (contract in src/providers/newsProvider.js)
  → ingestNews()                             (src/ingestion/ingestNews.js)
  → insertNewsEvent()                        (src/database/newsEvents.js)
  → news_events row, deduped by (provider, provider_event_id)
```

Shared rules live in `normalizeNewsEvent()` and only there: required
provider/headline, UTC ISO-8601 timestamps, uppercase deduped symbols, ticker
derived from the first symbol when absent, stringified provider event ids,
original payload preserved untouched in `raw` (persisted as `raw_payload`).
Adapters do field mapping and nothing else.

`ingestNews(db, provider, fetchOptions)` returns
`{ provider, fetched, inserted, duplicates, failed, insertedIds, errors }` —
duplicates are counted, never re-inserted; a bad event is recorded in
`errors` without aborting the batch. Dedup is scoped by provider name, so the
same id from two providers stores as two events.

## The injected-transport pattern

Each real adapter is a factory taking an injected transport:

```js
const provider = createAlpacaNewsProvider({
  fetchRawNews: async (options) => [...rawItems],
});
```

**By default no transport is configured and `fetchNews()` rejects with
"no transport configured".** This is deliberate: an adapter skeleton is
structurally incapable of making network calls or needing API keys. Tests
inject fixture-backed stubs; a real HTTP client becomes the default transport
in a later phase without changing any mapping logic. The registry test
(`tests/providerRegistry.test.js`) verifies every adapter rejects by default
while a fetch stub proves zero network attempts.

## Current providers

| Name            | Factory                          | Notes                                                          |
| --------------- | -------------------------------- | -------------------------------------------------------------- |
| `mock`          | `createMockProvider`             | In-memory items, supports symbol/since/until/limit filtering    |
| `alpaca`        | `createAlpacaNewsProvider`       | v1beta1 shape; dedicated numeric id                             |
| `benzinga`      | `createBenzingaNewsProvider`     | RFC-2822 timestamps; object-wrapped stocks/channels             |
| `alpha_vantage` | `createAlphaVantageNewsProvider` | No dedicated id → derived from article URL; compact timestamps  |
| `polygon`       | `createPolygonNewsProvider`      | String hash ids; published_utc already ISO; insights in raw     |

All factories are exported from `src/providers/index.js`; the registry test
fails if one goes missing or a name changes.

## Current limitations (deliberate)

- No real API clients yet — adapters are fixture/transport-injection only.
- No API keys or `.env` use anywhere in the provider layer.
- Provider-supplied sentiment (Alpha Vantage scores, Polygon insights) stays
  in `raw_payload` only; nothing writes to `sentiment_scores`. Our own
  sentiment/classification engine is Phase 3.
- `receivedAt` is stamped at normalization time; true wire-receipt timestamps
  arrive with the real transports.
- `dedup_group` remains null until cross-provider story grouping is built.

## Adding a provider

1. Create `src/providers/<name>NewsProvider.js` following the existing
   pattern: factory, injected `fetchRawNews`, throwing default, a
   `normalizeProviderItem` that maps fields into `normalizeNewsEvent()`.
2. Export it from `src/providers/index.js`.
3. Add static fixtures in `tests/fixtures/` and a fixture test file.
4. Add one entry to `PROVIDER_REGISTRY` in
   `tests/helpers/providerTestHelpers.js` — every registry-wide test then
   covers it automatically.
