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
// - Orders are single-leg MARKET orders only (type 'market', time_in_force
//   'day'): equity buy/sell and single option contract buy/sell. No
//   bracket/stop/limit/trailing, no spreads, no multi-leg.
//
// Verified API surface (docs.alpaca.markets, 2026-06), all on the paper host:
//   GET  /v2/account                -> account object
//   GET  /v2/positions              -> [ position objects ]
//   POST /v2/orders {symbol,qty,side,type,time_in_force} -> order object
//   headers: APCA-API-KEY-ID / APCA-API-SECRET-KEY (account-level pair)

/** HARD-CODED Alpaca PAPER endpoint. There is deliberately no live URL here. */
export const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';

/** Alpaca LIVE host — referenced ONLY so tests can assert we never use it. */
export const LIVE_BASE_URL_FORBIDDEN = 'https://api.alpaca.markets';

/** OCC option symbol, e.g. AAPL260116C00150000 (root + YYMMDD + C/P + strike*1000). */
export const OCC_OPTION_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

const ORDERS_PATH = '/v2/orders';
const ACCOUNT_PATH = '/v2/account';
const POSITIONS_PATH = '/v2/positions';

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

  /** One sanitized HTTP request to the paper host. Returns parsed JSON. */
  async function httpJson(method, path, bodyObj) {
    const url = `${PAPER_BASE_URL}${path}`;
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

  /**
   * Submit a single-leg option PAPER market order by OCC symbol. side 'buy'
   * opens a long call/put; 'sell' is permitted only to CLOSE an existing option
   * position (the caller enforces that — this client is a faucet). No spreads,
   * no multi-leg, no uncovered writing initiated here.
   */
  async function submitOptionMarketOrder({ optionSymbol, qty, side = 'buy' } = {}) {
    const sym = String(optionSymbol ?? '').trim().toUpperCase();
    if (!OCC_OPTION_RE.test(sym)) {
      throw new Error('alpacaPaperClient: optionSymbol must be a valid OCC option symbol');
    }
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('alpacaPaperClient: option qty (contracts) must be a positive integer');
    }
    if (!VALID_SIDES.has(side)) {
      throw new Error(`alpacaPaperClient: side must be buy/sell, got "${side}"`);
    }
    return postOrder({ symbol: sym, qty: quantity, side, type: 'market', time_in_force: 'day' });
  }

  return {
    name: 'alpaca_paper',
    baseUrl: PAPER_BASE_URL,
    getAccount,
    getPositions,
    submitMarketOrder,
    submitOptionMarketOrder,
  };
}
