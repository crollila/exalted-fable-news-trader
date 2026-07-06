# Real-Data Tier Plan — First Step Decision

Design/review document only. Nothing here is implemented by this document.
Implementation of any real-data step requires separate explicit approval.

## 1. What the fixture tier already proves

As of tests/pipeline.test.js (132/132 passing), the complete local research
loop runs end-to-end with zero external calls: provider fixture →
normalized event → news_events row → fixture classifier →
sentiment_scores row → fixture PriceSource → price_reactions rows, with
the events × scores × reactions research join and idempotency proven at
every stage. Every external dependency sits behind a tested contract with
a fixture implementation and a throwing default:

| Contract            | Fixture impl              | Real impl missing      |
| ------------------- | ------------------------- | ---------------------- |
| NewsProvider        | mock + 4 adapter skeletons | news API transports    |
| Classifier          | fixture classifier        | model client           |
| PriceSource         | fixture price source      | market-data client     |

The real-data tier replaces fixtures with real implementations one
contract at a time, behind the same interfaces, each as its own reviewed
step.

## 2. What each option unlocks

**Option A — first real news provider transport** (e.g. an HTTP
`fetchRawNews` default for the Alpaca News adapter): real headlines start
accumulating in news_events with true wire `received_at` timestamps. That
fixes the receivedAt-stamped-at-normalization debt item and starts
building the event dataset that everything downstream needs. Volume and
field-shape surprises from real feeds get discovered early.

**Option B — first real market-data client** (a real
`getTradesAround` for the PriceSource contract): real measured reactions
— but only for events we have, and we have none. Real prices measured
against fixture news events answer no research question. It also forces
the session-calendar work (real EOD, market_closed, DST) immediately.

## 3. Risks of each ordering

**Provider transport first:**
- Real feeds may not match the fixture-modeled shapes exactly (fields
  missing, pagination, rate limits). Mitigation: the adapter mapping layer
  is the only thing that touches raw shapes, and raw_payload preserves
  everything for re-normalization if mapping needs fixing.
- A polling loop / scheduling question arrives (how often to fetch).
  Mitigation: first step is a manually-invoked one-shot fetch, not a
  daemon; scheduling is its own later task.
- Key handling enters the codebase for the first time (see §4).

**Market-data client first:**
- Unlocks nothing measurable: no real events exist to anchor windows, so
  real prices would only ever measure synthetic fixtures — effort spent
  with no research output.
- Forces the hardest deferred policies (session calendar, market_closed,
  EOD definition) before any data exists to justify the choices.
- Historical trade-data queries are expensive on some plans; without real
  events there is no way to scope which windows are even needed.

## 4. API-key / .env safety plan (applies to ANY real client)

- Keys live only in the uncommitted `.env`; `.env.example` documents names
  with empty values (ALPACA_API_KEY_ID etc. already listed).
- Config loading extends `src/config.js` only: a real transport asks
  config for its key; it never reads process.env directly and never takes
  a key as a hard-coded string.
- A real transport with no key configured must throw a clear "not
  configured" error at construction/first call — the same disabled-by-
  default behavior the fixture defaults already establish.
- `.gitignore` already excludes `.env`; the pre-commit checklist
  (CLAUDE.md workflow) continues to verify no keys/secrets are staged.
- Keys are never passed through normalize/storage paths, so they cannot
  reach raw_payload or any table.

## 5. No-secret logging rules

- Never log the key, the Authorization header, or full request URLs that
  embed keys as query parameters (Alpha Vantage style). Log the endpoint
  path and a redacted marker only.
- Error objects from HTTP clients may embed request config — log
  `err.message` and a sanitized summary, never the raw error object.
- Raw API *response* payloads are data and may be stored (raw_payload),
  but raw *request* objects are never stored or logged.
- A test should assert the transport's error path does not leak the key
  string into thrown messages.

## 6. Test strategy

Unchanged in philosophy: the existing fixture tests remain the regression
suite and never make network calls. The real transport adds:
- unit tests with an injected fake HTTP layer (the transport's own
  fetch/client is itself injectable), covering success, HTTP errors,
  rate-limit responses, pagination, and key-redaction in errors;
- the not-configured-throws test;
- NO live-network tests in `npm test`. A separate, manually-run,
  explicitly named script (never in CI/default test path) can exist for
  live smoke checks, requiring a real key in .env.

## 7. Keeping real clients disabled by default

The pattern is already built: every adapter's default transport throws.
That stays. A real transport is only ever activated by explicit
construction (e.g. `createAlpacaNewsProvider({ fetchRawNews:
createAlpacaHttpTransport(config) })`) in code paths that do not run in
tests or at import time. No auto-wiring, no "if key present, go live"
implicit behavior — enabling real data is always an explicit, visible
line of code plus a configured key.

## 8. Recommendation: real news provider transport first (Option A)

The preferred-recommendation condition is met: the Alpaca News transport
fits entirely behind the existing provider abstraction. The adapter,
normalization, dedup, persistence, and ingestion layers need zero changes
— the new code is exactly one injected `fetchRawNews` function plus
config/key plumbing. The tradeoff is sequencing, not architecture:
news-before-prices means real events accumulate (with true received_at
timestamps) while the market-data step is designed; prices-before-news
produces measurements of nothing. Alpaca specifically, because the
account/keys will exist anyway for paper trading, its news API is
included with brokerage access, and the adapter skeleton is already
field-mapped against its v1beta1 shape.

Proposed first implementation step (separate approval required):
`createAlpacaNewsHttpTransport(config)` — one-shot historical/recent news
fetch with injected HTTP layer, key from config, not-configured throw,
fake-HTTP tests, no polling loop, no scheduling.

## 9. Explicitly out of scope for the real-data tier's first step

- No trading logic, no paper orders, no risk-engine changes.
- No model calls (the real model client is its own later step).
- No committed API keys; no `.env` edits by tooling.
- No dependencies unless separately approved (Node's built-in fetch is
  expected to suffice).
- No polling daemons or schedulers; first transport is manually invoked.
- No market-data client (Option B follows once real events exist).
