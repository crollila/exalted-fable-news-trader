// src/providers/alpacaNewsHttpTransport.js — Real Alpaca News HTTP transport.
//
// First real-data tier step (docs/real-data-tier-plan.md §8). This is ONLY a
// transport: it fetches raw Alpaca news payloads one-shot and returns them.
// All normalization stays in the existing Alpaca adapter
// (createAlpacaNewsProvider({ fetchRawNews: createAlpacaNewsHttpTransport(config) })).
//
// Safety properties:
// - DISABLED BY DEFAULT: never auto-enabled. It exists only when explicitly
//   constructed, and construction throws "not configured" without keys.
// - Keys come ONLY from config (src/config.js reads process.env; nothing
//   here touches process.env). Keys go into request headers and NOWHERE
//   else — never thrown, logged, returned, or persisted.
// - Errors are sanitized: messages are built from static text + status
//   codes, and any accidental key occurrence is redacted defensively.
// - ONE-SHOT: a single GET per call. No polling, scheduling, pagination
//   following, or background behavior. (Alpaca's page_token is ignored in
//   this step; a fetch returns at most one page.)
// - The HTTP function is injectable for tests; npm test never hits the
//   network.

const DEFAULT_BASE_URL = 'https://data.alpaca.markets/v1beta1/news';

/** Replace any occurrence of the given secrets in text with [redacted]. */
function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Create a one-shot Alpaca News fetchRawNews transport.
 *
 * @param {object} config  result of loadConfig(); uses config.alpacaNews only
 * @param {object} [options]
 * @param {Function} [options.httpFetch]  injected fetch-compatible function
 *   (tests inject fakes; real use defaults to globalThis.fetch)
 * @param {string} [options.baseUrl]
 * @returns {(fetchOptions?: import('./newsProvider.js').FetchNewsOptions) => Promise<object[]>}
 * @throws immediately (before any HTTP) if credentials are not configured.
 */
export function createAlpacaNewsHttpTransport(config, { httpFetch, baseUrl = DEFAULT_BASE_URL } = {}) {
  const keyId = config?.alpacaNews?.keyId;
  const secretKey = config?.alpacaNews?.secretKey;
  if (!keyId || !secretKey) {
    throw new Error(
      'alpacaNewsHttpTransport: not configured — set ALPACA_API_KEY_ID and ' +
        'ALPACA_API_SECRET_KEY in .env (see .env.example). No HTTP call was made.'
    );
  }
  const secrets = [keyId, secretKey];
  const doFetch = httpFetch ?? globalThis.fetch;

  /** One-shot fetch of raw Alpaca news items (single page, no follow-up). */
  return async function fetchRawNews({ symbols, since, until, limit } = {}) {
    const url = new URL(baseUrl);
    if (Array.isArray(symbols) && symbols.length > 0) {
      url.searchParams.set('symbols', symbols.map((s) => String(s).trim().toUpperCase()).join(','));
    }
    if (since !== undefined && since !== null) {
      url.searchParams.set('start', new Date(since).toISOString());
    }
    if (until !== undefined && until !== null) {
      url.searchParams.set('end', new Date(until).toISOString());
    }
    if (Number.isInteger(limit) && limit > 0) {
      url.searchParams.set('limit', String(limit));
    }

    let response;
    try {
      response = await doFetch(url.toString(), {
        method: 'GET',
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secretKey,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      // Network-level failure: never rethrow the raw error (HTTP client
      // errors can embed request config/headers). Sanitized summary only.
      throw new Error(`alpacaNewsHttpTransport: request failed: ${redact(err?.message, secrets)}`);
    }

    if (!response.ok) {
      // Status/statusText only — never the URL object, headers, or body.
      throw new Error(
        `alpacaNewsHttpTransport: HTTP ${response.status} ${redact(response.statusText ?? '', secrets)}`
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('alpacaNewsHttpTransport: response body was not valid JSON');
    }

    // Alpaca wraps items as { news: [...] }; tolerate a bare array too.
    const items = Array.isArray(payload) ? payload : payload?.news;
    if (!Array.isArray(items)) {
      throw new Error(
        `alpacaNewsHttpTransport: unexpected payload shape (expected news array, got ${typeof payload})`
      );
    }
    return items;
  };
}
