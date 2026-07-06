# News Provider Adapters

How ExaltedFable ingests news without being hard-coded to any single source.

## Purpose

Every news source (Alpaca, Benzinga, future providers) has its own field
names, timestamp formats, and quirks. The provider abstraction confines those
differences to one small adapter file per source. Everything downstream —
persistence, event study, sentiment, reporting — sees exactly one canonical
event shape and never a provider-specific field.

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
inject fixture-backed stubs; the scripts inject the real HTTP client
explicitly when credentials exist. The registry test
(`tests/providerRegistry.test.js`) verifies every adapter rejects by default
while a fetch stub proves zero network attempts.

## Current providers

| Name       | Factory                      | Notes                                                                 |
| ---------- | ---------------------------- | --------------------------------------------------------------------- |
| `mock`     | `createMockProvider`         | In-memory items, supports symbol/since/until/limit filtering           |
| `alpaca`   | `createAlpacaNewsProvider`   | Primary source; real transport `createAlpacaNewsHttpTransport`         |
| `benzinga` | `createBenzingaNewsProvider` | Optional plug-in; working HTTP transport parked on `backup/pre-cleanup` |

All factories are exported from `src/providers/index.js`; the registry test
fails if one goes missing or a name changes.

## Current limitations (deliberate)

- Only Alpaca has a wired real transport; Benzinga runs on injected/fixture
  transports until its parked transport returns with a key.
- Provider-supplied sentiment stays in `raw_payload` only; nothing writes to
  `sentiment_scores` except ExaltedFable's own classifiers.
- `receivedAt` is stamped at normalization time.
- `dedup_group` remains null until cross-provider story grouping is built
  (a candidate for cherry-picking from `backup/pre-cleanup`).

## Adding a provider

1. Create `src/providers/<name>NewsProvider.js` following the existing
   pattern: factory, injected `fetchRawNews`, throwing default, a
   `normalizeProviderItem` that maps fields into `normalizeNewsEvent()`.
2. Export it from `src/providers/index.js`.
3. Add static fixtures in `tests/fixtures/` and a fixture test file.
4. Add one entry to `PROVIDER_REGISTRY` in
   `tests/helpers/providerTestHelpers.js` — every registry-wide test then
   covers it automatically.
