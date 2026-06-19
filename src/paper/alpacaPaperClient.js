// src/paper/alpacaPaperClient.js — Real Alpaca PAPER order client (Phase 5).
//
// The first and ONLY order-submitting client in the project. It exists behind
// the same safety regime as the read-only Alpaca clients
// (alpacaNewsHttpTransport, alpacaTradesPriceSource): explicit construction,
// injected HTTP, sanitized/redacted errors, no import-time network.
//
// PAPER-ONLY BY CONSTRUCTION — this is the load-bearing safety property:
// - The base URL is the HARD-CODED Alpaca paper endpoint
//   (https://paper-api.alpaca.markets). It is NOT a constructor option and NOT
//   read from config/env, so there is no code path — and no env var — that can
//   point this client at the live trading endpoint. Live trading stays
//   impossible regardless of config.liveTradingEnabled.
// - Only a market order is supported (type 'market', time_in_force 'day').
//   No bracket/stop/limit/trailing orders, no options, no multi-leg.
//
// Verified API (docs.alpaca.markets, 2026-06):
//   POST https://paper-api.alpaca.markets/v2/orders
//   headers: APCA-API-KEY-ID / APCA-API-SECRET-KEY (same account-level pair)
//   body:    { symbol, qty, side, type, time_in_force }
//   200 -> order object { id, client_order_id, symbol, qty, side, type,
//          status, submitted_at, filled_qty, filled_avg_price, ... }

/** HARD-CODED Alpaca PAPER endpoint. There is deliberately no live URL here. */
export const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';

/** Alpaca LIVE host — referenced ONLY so we can assert we never use it. */
export const LIVE_BASE_URL_FORBIDDEN = 'https://api.alpaca.markets';

const ORDERS_PATH = '/v2/orders';

/** Sides this client will accept. The proposal layer restricts to 'buy'. */
const VALID_SIDES = new Set(['buy', 'sell']);

/** Replace any occurrence of the given secrets in text with [redacted]. */
function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Coerce a value to a finite number, or null. */
function numOrNull(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Map a raw Alpaca order payload to a SANITIZED whitelist. Never returns the
 * raw payload, headers, or request config — only the fields the report needs.
 */
export function sanitizeOrder(payload) {
  return {
    id: typeof payload?.id === 'string' ? payload.id : null,
    clientOrderId: typeof payload?.client_order_id === 'string' ? payload.client_order_id : null,
    symbol: typeof payload?.symbol === 'string' ? payload.symbol : null,
    side: typeof payload?.side === 'string' ? payload.side : null,
    qty: numOrNull(payload?.qty),
    type: typeof payload?.type === 'string' ? payload.type : null,
    status: typeof payload?.status === 'string' ? payload.status : null,
    submittedAt: typeof payload?.submitted_at === 'string' ? payload.submitted_at : null,
    filledQty: numOrNull(payload?.filled_qty),
    filledAvgPrice: numOrNull(payload?.filled_avg_price),
  };
}

/**
 * Create a real Alpaca PAPER order client.
 *
 * Explicit construction only — the single place a paper-order path comes into
 * existence, and only with configured keys. The endpoint is paper-only and
 * cannot be overridden.
 *
 * @param {object} config  result of loadConfig(); uses config.alpacaPaper only
 * @param {object} [options]
 * @param {Function} [options.httpFetch]  injected fetch-compatible function
 *   (tests inject fakes; real use defaults to globalThis.fetch). NOTE: there is
 *   intentionally no baseUrl option — the paper endpoint is fixed.
 * @returns {{ name: string, baseUrl: string,
 *   submitMarketOrder: (o: {symbol: string, qty: number, side?: string})
 *     => Promise<object> }}
 * @throws immediately (before any HTTP) if paper credentials are not configured.
 */
export function createAlpacaPaperClient(config, { httpFetch } = {}) {
  const keyId = config?.alpacaPaper?.keyId;
  const secretKey = config?.alpacaPaper?.secretKey;
  if (!keyId || !secretKey) {
    throw new Error(
      'alpacaPaperClient: not configured — set ALPACA_API_KEY_ID and ' +
        'ALPACA_API_SECRET_KEY in .env (see .env.example). No HTTP call was made.'
    );
  }
  const secrets = [keyId, secretKey];
  const doFetch = httpFetch ?? globalThis.fetch;
  const ordersUrl = `${PAPER_BASE_URL}${ORDERS_PATH}`;

  /**
   * Submit a single PAPER market order. Validates input, posts to the paper
   * endpoint, and returns a sanitized order summary. Throws sanitized errors
   * only (key/secret redacted); never rethrows the raw fetch error/response.
   */
  async function submitMarketOrder({ symbol, qty, side = 'buy' } = {}) {
    const sym = String(symbol ?? '').trim().toUpperCase();
    if (!sym) throw new Error('alpacaPaperClient: symbol must be a non-empty string');
    const quantity = Number(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('alpacaPaperClient: qty must be a positive number');
    }
    if (!VALID_SIDES.has(side)) {
      throw new Error(`alpacaPaperClient: side must be buy/sell, got "${side}"`);
    }

    const body = JSON.stringify({
      symbol: sym,
      qty: quantity,
      side,
      type: 'market',
      time_in_force: 'day',
    });

    let response;
    try {
      response = await doFetch(ordersUrl, {
        method: 'POST',
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secretKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      });
    } catch (err) {
      // Never rethrow raw fetch errors (they can embed request config/headers).
      throw new Error(`alpacaPaperClient: request failed: ${redact(err?.message, secrets)}`);
    }

    if (!response.ok) {
      // Status/statusText only — never the URL, headers, or body.
      throw new Error(
        `alpacaPaperClient: HTTP ${response.status} ${redact(response.statusText ?? '', secrets)}`
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('alpacaPaperClient: response body was not valid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('alpacaPaperClient: unexpected order payload shape (expected object)');
    }
    return sanitizeOrder(payload);
  }

  return { name: 'alpaca_paper', baseUrl: PAPER_BASE_URL, submitMarketOrder };
}
