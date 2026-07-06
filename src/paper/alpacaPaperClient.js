// src/paper/alpacaPaperClient.js — Real Alpaca PAPER client (Phase 5).
//
// The ONLY order-submitting client in the project. Same safety regime as the
// read-only Alpaca clients: explicit construction, injected HTTP, sanitized/
// redacted errors, no import-time network.
//
// PAPER-ONLY BY CONSTRUCTION — the load-bearing safety property:
// - The base URL is the HARD-CODED Alpaca paper endpoint
//   (https://paper-api.alpaca.markets). It is NOT a constructor option and NOT
//   read from config/env, so no code path — and no env var — can point this
//   client at the live trading endpoint. Live trading stays impossible
//   regardless of config.liveTradingEnabled.
// - Orders are single-leg equity MARKET orders only (type 'market',
//   time_in_force 'day'): buy/sell. No bracket/stop/limit/trailing, no
//   spreads, no multi-leg, no options.
//
// Verified API surface (docs.alpaca.markets, 2026-06), all on the paper host:
//   GET  /v2/account                -> account object
//   GET  /v2/positions              -> [ position objects ]
//   GET  /v2/clock                  -> market clock
//   GET  /v2/calendar               -> market calendar days
//   GET  /v2/assets/{symbol}        -> asset tradability/shortability
//   POST /v2/orders {symbol,qty,side,type,time_in_force} -> order object
//   headers: APCA-API-KEY-ID / APCA-API-SECRET-KEY (account-level pair)

/** HARD-CODED Alpaca PAPER endpoint. There is deliberately no live URL here. */
export const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';

/** Alpaca LIVE host — referenced ONLY so tests can assert we never use it. */
export const LIVE_BASE_URL_FORBIDDEN = 'https://api.alpaca.markets';

/** Alpaca market-data host. Read-only, never used for order submission. */
export const DATA_BASE_URL = 'https://data.alpaca.markets';

const ORDERS_PATH = '/v2/orders';
const ACCOUNT_PATH = '/v2/account';
const POSITIONS_PATH = '/v2/positions';
const CLOCK_PATH = '/v2/clock';
const CALENDAR_PATH = '/v2/calendar';
const ASSETS_PATH = '/v2/assets';

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

/** Coerce an Alpaca boolean-ish field to a strict boolean, or null if absent. */
function boolOrNull(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function upperOrNull(value) {
  const s = stringOrNull(value);
  return s ? s.toUpperCase() : null;
}

function appendQuery(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) query.set(key, value.join(','));
    } else {
      query.set(key, String(value));
    }
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Map a raw Alpaca order payload to a SANITIZED whitelist (never the raw payload). */
export function sanitizeOrder(payload) {
  return {
    id: typeof payload?.id === 'string' ? payload.id : null,
    clientOrderId: typeof payload?.client_order_id === 'string' ? payload.client_order_id : null,
    symbol: typeof payload?.symbol === 'string' ? payload.symbol : null,
    side: typeof payload?.side === 'string' ? payload.side : null,
    qty: numOrNull(payload?.qty),
    type: typeof payload?.type === 'string' ? payload.type : null,
    assetClass: typeof payload?.asset_class === 'string' ? payload.asset_class : null,
    status: typeof payload?.status === 'string' ? payload.status : null,
    submittedAt: typeof payload?.submitted_at === 'string' ? payload.submitted_at : null,
    filledQty: numOrNull(payload?.filled_qty),
    filledAvgPrice: numOrNull(payload?.filled_avg_price),
    filledAt: typeof payload?.filled_at === 'string' ? payload.filled_at : null,
    canceledAt: typeof payload?.canceled_at === 'string' ? payload.canceled_at : null,
    expiredAt: typeof payload?.expired_at === 'string' ? payload.expired_at : null,
    updatedAt: typeof payload?.updated_at === 'string' ? payload.updated_at : null,
    replacedAt: typeof payload?.replaced_at === 'string' ? payload.replaced_at : null,
  };
}

/** Map a raw Alpaca account payload to a SANITIZED whitelist. */
export function sanitizeAccount(payload) {
  return {
    id: typeof payload?.id === 'string' ? payload.id : null,
    status: typeof payload?.status === 'string' ? payload.status : null,
    equity: numOrNull(payload?.equity),
    cash: numOrNull(payload?.cash),
    buyingPower: numOrNull(payload?.buying_power),
    multiplier: numOrNull(payload?.multiplier),
    portfolioValue: numOrNull(payload?.portfolio_value),
    patternDayTrader: boolOrNull(payload?.pattern_day_trader),
    tradingBlocked: boolOrNull(payload?.trading_blocked),
    accountBlocked: boolOrNull(payload?.account_blocked),
    optionsApprovedLevel: numOrNull(payload?.options_approved_level),
    optionsTradingLevel: numOrNull(payload?.options_trading_level),
  };
}

/** Map a raw Alpaca position payload to a SANITIZED whitelist. */
export function sanitizePosition(payload) {
  return {
    symbol: typeof payload?.symbol === 'string' ? payload.symbol : null,
    qty: numOrNull(payload?.qty),
    side: typeof payload?.side === 'string' ? payload.side : null,
    marketValue: numOrNull(payload?.market_value),
    costBasis: numOrNull(payload?.cost_basis),
    unrealizedPl: numOrNull(payload?.unrealized_pl),
    unrealizedPlpc: numOrNull(payload?.unrealized_plpc),
    assetClass: typeof payload?.asset_class === 'string' ? payload.asset_class : null,
  };
}

/** Map a raw Alpaca clock payload to a SANITIZED whitelist. */
export function sanitizeClock(payload) {
  return {
    timestamp: stringOrNull(payload?.timestamp),
    isOpen: boolOrNull(payload?.is_open),
    nextOpen: stringOrNull(payload?.next_open),
    nextClose: stringOrNull(payload?.next_close),
  };
}

/** Map a raw Alpaca calendar day payload to a SANITIZED whitelist. */
export function sanitizeCalendarDay(payload) {
  return {
    date: stringOrNull(payload?.date),
    open: stringOrNull(payload?.open),
    close: stringOrNull(payload?.close),
    sessionOpen: stringOrNull(payload?.session_open),
    sessionClose: stringOrNull(payload?.session_close),
  };
}

/** Map a raw Alpaca asset payload to a SANITIZED whitelist. */
export function sanitizeAsset(payload) {
  return {
    id: stringOrNull(payload?.id),
    symbol: upperOrNull(payload?.symbol),
    name: stringOrNull(payload?.name),
    assetClass: stringOrNull(payload?.class),
    exchange: stringOrNull(payload?.exchange),
    status: stringOrNull(payload?.status),
    tradable: boolOrNull(payload?.tradable),
    marginable: boolOrNull(payload?.marginable),
    shortable: boolOrNull(payload?.shortable),
    easyToBorrow: boolOrNull(payload?.easy_to_borrow),
    fractionable: boolOrNull(payload?.fractionable),
  };
}

/**
 * Create a real Alpaca PAPER client. Explicit construction only; the endpoint is
 * paper-only and cannot be overridden (no baseUrl option, no env override).
 *
 * @param {object} config  loadConfig() result; uses config.alpacaPaper only
 * @param {object} [options]
 * @param {Function} [options.httpFetch]  injected fetch (tests inject fakes)
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

  /** One sanitized HTTP request. Returns parsed JSON (or {status} when parseJson=false). */
  async function httpJson(method, path, bodyObj, { baseUrl = PAPER_BASE_URL, parseJson = true } = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {
      'APCA-API-KEY-ID': keyId,
      'APCA-API-SECRET-KEY': secretKey,
      Accept: 'application/json',
    };
    if (bodyObj) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(bodyObj ? { body: JSON.stringify(bodyObj) } : {}),
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
    // Some endpoints (order cancel) return 204 No Content — no body to parse.
    if (!parseJson) return { status: response.status };
    try {
      return await response.json();
    } catch {
      throw new Error('alpacaPaperClient: response body was not valid JSON');
    }
  }

  /** POST one market order body and return the sanitized order. */
  async function postOrder(orderBody) {
    const payload = await httpJson('POST', ORDERS_PATH, orderBody);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('alpacaPaperClient: unexpected order payload shape (expected object)');
    }
    return sanitizeOrder(payload);
  }

  /** GET the account snapshot (sanitized). */
  async function getAccount() {
    const payload = await httpJson('GET', ACCOUNT_PATH);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('alpacaPaperClient: unexpected account payload shape (expected object)');
    }
    return sanitizeAccount(payload);
  }

  /** GET open positions (sanitized array). */
  async function getPositions() {
    const payload = await httpJson('GET', POSITIONS_PATH);
    if (!Array.isArray(payload)) {
      throw new Error('alpacaPaperClient: unexpected positions payload shape (expected array)');
    }
    return payload.map(sanitizePosition);
  }

  /** GET the Alpaca paper market clock (sanitized). */
  async function getClock() {
    const payload = await httpJson('GET', CLOCK_PATH);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('alpacaPaperClient: unexpected clock payload shape (expected object)');
    }
    return sanitizeClock(payload);
  }

  /** GET Alpaca calendar days (sanitized array). */
  async function getCalendar({ start = null, end = null } = {}) {
    const payload = await httpJson('GET', appendQuery(CALENDAR_PATH, { start, end }));
    if (!Array.isArray(payload)) {
      throw new Error('alpacaPaperClient: unexpected calendar payload shape (expected array)');
    }
    return payload.map(sanitizeCalendarDay);
  }

  /** GET one asset by symbol (sanitized tradability/shortability fields). */
  async function getAsset(symbol) {
    const sym = String(symbol ?? '').trim().toUpperCase();
    if (!sym) throw new Error('alpacaPaperClient: symbol must be a non-empty string');
    const payload = await httpJson('GET', `${ASSETS_PATH}/${encodeURIComponent(sym)}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('alpacaPaperClient: unexpected asset payload shape (expected object)');
    }
    return sanitizeAsset(payload);
  }

  /** Submit a single equity PAPER market order (buy=long, sell=short/close). */
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
    return postOrder({ symbol: sym, qty: quantity, side, type: 'market', time_in_force: 'day' });
  }

  /** GET one order by broker id (sanitized) — used to poll/reconcile fills. */
  async function getOrder(orderId) {
    const id = String(orderId ?? '').trim();
    if (!id) throw new Error('alpacaPaperClient: orderId must be a non-empty string');
    const payload = await httpJson('GET', `${ORDERS_PATH}/${encodeURIComponent(id)}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('alpacaPaperClient: unexpected order payload shape (expected object)');
    }
    return sanitizeOrder(payload);
  }

  /** DELETE (cancel) one open order by broker id. Returns { ok, status }. */
  async function cancelOrder(orderId) {
    const id = String(orderId ?? '').trim();
    if (!id) throw new Error('alpacaPaperClient: orderId must be a non-empty string');
    const res = await httpJson('DELETE', `${ORDERS_PATH}/${encodeURIComponent(id)}`, null, { parseJson: false });
    return { ok: true, status: res?.status ?? null };
  }

  return {
    name: 'alpaca_paper',
    baseUrl: PAPER_BASE_URL,
    getAccount,
    getPositions,
    getClock,
    getCalendar,
    getAsset,
    submitMarketOrder,
    getOrder,
    cancelOrder,
  };
}
