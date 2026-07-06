// src/providers/benzingaNewsHttpTransport.js - Real Benzinga News HTTP transport.
//
// This is ONLY a transport: it fetches raw Benzinga news items and returns
// them to the existing Benzinga adapter for normalization.
//
// Safety properties:
// - DISABLED BY DEFAULT: construct explicitly, and construction throws without
//   BENZINGA_API_KEY in central config.
// - The key comes ONLY from config and is sent in the Authorization header,
//   never in the URL.
// - Errors are sanitized and classified by status only; raw URLs, headers,
//   payloads, and request objects are never logged or thrown.
// - Delta semantics: `publishedSince` (documented published-time delta) bounds
//   the fetch, so cursors resume from a retained watermark.
// - BOUNDED pagination: when `maxPages` is provided the transport follows
//   Benzinga's `page`/`pageSize` up to that page bound, sorting created:asc so a
//   truncated run resumes safely. Without `maxPages` it stays a single one-shot
//   GET (legacy behavior, unchanged: sort=created:desc, no page param).
// - HTTP is injectable for tests; npm test never touches the network.

const DEFAULT_BASE_URL = 'https://api.benzinga.com/api/v2/news';
const DEFAULT_TIMEOUT_MS = 10_000;
const HARD_PAGE_CAP = 20; // absolute safety ceiling regardless of caller request

function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function unixSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function ymd(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function clampPageSize(limit) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return Math.min(n, 100);
}

function sanitizedHttpError(prefix, status, statusText, secrets) {
  const err = new Error(`${prefix}: HTTP ${status}${statusText ? ` ${redact(statusText, secrets)}` : ''}`);
  err.status = status;
  err.provider = 'benzinga';
  return err;
}

/**
 * Create a Benzinga News fetchRawNews transport.
 *
 * @param {object} config result of loadConfig(); uses config.benzingaNews only
 * @param {object} [options]
 * @param {Function} [options.httpFetch] injected fetch-compatible function
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 * @returns {(fetchOptions?: object) => Promise<object[]|{items: object[], pages: number, truncated: boolean}>}
 */
export function createBenzingaNewsHttpTransport(
  config,
  { httpFetch, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const apiKey = config?.benzingaNews?.apiKey;
  if (!apiKey) {
    throw new Error(
      'benzingaNewsHttpTransport: not configured - set BENZINGA_API_KEY in .env ' +
        '(see .env.example). No HTTP call was made.'
    );
  }
  const secrets = [apiKey];
  const doFetch = httpFetch ?? globalThis.fetch;

  /** Build one request URL. `sort`/`page` are pagination-only knobs. */
  function buildUrl({ symbols, since, until, pageSize, sort = 'created:desc', page = null }) {
    const url = new URL(baseUrl);
    if (Array.isArray(symbols) && symbols.length > 0) {
      url.searchParams.set(
        'tickers',
        symbols.slice(0, 50).map((s) => String(s).trim().toUpperCase()).filter(Boolean).join(',')
      );
    }
    const publishedSince = unixSeconds(since);
    if (publishedSince !== null) url.searchParams.set('publishedSince', String(publishedSince));
    const dateTo = ymd(until);
    if (dateTo !== null) url.searchParams.set('dateTo', dateTo);
    if (pageSize !== null) url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('displayOutput', 'full');
    url.searchParams.set('sort', sort);
    if (page !== null) url.searchParams.set('page', String(page));
    return url;
  }

  /** One GET; returns the raw items array. Throws sanitized errors only. */
  async function requestPage(url) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer =
      controller && Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? setTimeout(() => controller.abort(), Number(timeoutMs))
        : null;

    let response;
    try {
      response = await doFetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: `token ${apiKey}`, Accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      const out = new Error(
        timedOut
          ? 'benzingaNewsHttpTransport: request failed: timeout'
          : `benzingaNewsHttpTransport: request failed: ${redact(err?.message, secrets)}`
      );
      out.provider = 'benzinga';
      out.reason = timedOut ? 'timeout' : 'request failed';
      throw out;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      throw sanitizedHttpError('benzingaNewsHttpTransport', response.status, response.statusText ?? '', secrets);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      const err = new Error('benzingaNewsHttpTransport: response body was not valid JSON');
      err.provider = 'benzinga';
      err.reason = 'malformed response';
      throw err;
    }

    const items = Array.isArray(payload) ? payload : payload?.news;
    if (!Array.isArray(items)) {
      const err = new Error(
        `benzingaNewsHttpTransport: unexpected payload shape (expected news array, got ${typeof payload})`
      );
      err.provider = 'benzinga';
      err.reason = 'malformed response';
      throw err;
    }
    return items;
  }

  return async function fetchRawNews({ symbols, since, until, limit, maxPages } = {}) {
    const pageSize = clampPageSize(limit);
    // Legacy one-shot path (no maxPages): a single GET, sort=created:desc.
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      return requestPage(buildUrl({ symbols, since, until, pageSize }));
    }

    // Bounded pagination: created:asc so a truncated run resumes safely. Benzinga
    // has no page token, so "more pages remain" is inferred from a full page.
    const effectivePageSize = pageSize ?? 50;
    const pageCap = Math.min(maxPages, HARD_PAGE_CAP);
    const all = [];
    let pages = 0;
    let truncated = false;
    for (let page = 0; ; page += 1) {
      const items = await requestPage(
        buildUrl({ symbols, since, until, pageSize: effectivePageSize, sort: 'created:asc', page })
      );
      all.push(...items);
      pages += 1;
      if (items.length < effectivePageSize) break; // short page => last page
      if (pages >= pageCap) { truncated = true; break; }
    }
    return { items: all, pages, truncated };
  };
}
