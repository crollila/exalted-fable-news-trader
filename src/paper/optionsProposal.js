// src/paper/optionsProposal.js — PAPER options proposal.
//
// SCOPE — deliberately bounded and safe:
// - Single-leg LONG options only: BUY a call (bullish) or a put (bearish).
//   No spreads, no multi-leg, no auto-rolls, no selling uncovered options.
//   Positions are closed by the option monitor (sell-to-close only).
// - Contract discovery / quote validation happens downstream through injected
//   broker/data clients. An explicit --option-symbol narrows discovery to that
//   OCC contract; without it, the runtime chooses one eligible long call/put.
// - Execution is gated by the SAME global switches as equities: dry run is the
//   default; orders go out only with --execute-paper (plus the option entry
//   session gate).
// - PURE function (no HTTP, no DB). The risk/premium/exposure checks live in
//   paperRisk.js; the capability gate lives in the caller.

import { OCC_OPTION_RE } from './alpacaPaperClient.js';
import { summarizeScore, DEFAULT_THRESHOLDS, USABLE_PARSER_STATUSES } from './paperTradeProposal.js';

/** Option intents the bot can express. Only the long ones are executable here. */
export const OPTION_INTENTS = Object.freeze([
  'bullish_call', 'bearish_put', 'hedge_put', 'covered_call_candidate', 'none',
]);

export const DEFAULT_OPTION_CONTRACT_LIMIT = 1;
export const MAX_OPTION_CONTRACTS = 10;

/** Clamp requested option contracts to [1, MAX_OPTION_CONTRACTS]; junk -> default. */
export function clampContracts(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isInteger(v) || v <= 0) return DEFAULT_OPTION_CONTRACT_LIMIT;
  return Math.min(v, MAX_OPTION_CONTRACTS);
}

/**
 * Parse an OCC option symbol, e.g. AAPL260116C00150000.
 * @returns {{ root:string, expiry:string, type:'C'|'P', strike:number }|null}
 */
export function parseOccSymbol(sym) {
  const s = String(sym ?? '').trim().toUpperCase();
  if (!OCC_OPTION_RE.test(s)) return null;
  const m = s.match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yy, mm, dd, type, strike8] = m;
  return {
    root,
    expiry: `20${yy}-${mm}-${dd}`,
    type,
    strike: Number(strike8) / 1000,
  };
}

/** Whole days from `now` (ms) until an expiry date 'YYYY-MM-DD' (UTC). */
function daysUntil(expiry, nowMs) {
  const exp = Date.parse(`${expiry}T00:00:00.000Z`);
  if (!Number.isFinite(exp)) return null;
  return Math.round((exp - nowMs) / 86_400_000);
}

function fmt(n) {
  return n === null || n === undefined ? '(none)' : String(Math.round(n * 1000) / 1000);
}

/** Map model direction to a long option intent. */
export function intentForDirection(direction) {
  if (direction === 'up') return 'bullish_call';
  if (direction === 'down') return 'bearish_put';
  return 'none';
}

/**
 * Propose a single-leg long option for a scored event. Returns a structured
 * decision. `enabled:false` means options are switched off (skip silently).
 *
 * @param {object} args
 * @param {{id?:number, ticker?:string}} args.event
 * @param {object} args.score
 * @param {boolean} [args.allowOptions]    strategy-settings/CLI gate
 * @param {boolean} [args.optionsEnabled]  central PAPER_ENABLE_OPTIONS gate
 * @param {string|null} [args.optionSymbol]   optional OCC symbol to narrow discovery
 * @param {string[]} [args.allowedSymbols]
 * @param {object} [args.thresholds]
 * @param {number} [args.optionContractLimit]
 * @param {number|null} [args.optionExpiryDaysMin]
 * @param {number|null} [args.optionExpiryDaysMax]
 * @param {number|null} [args.optionMaxPremium]
 * @param {number} [args.nowMs]  injectable clock for expiry checks
 */
export function proposeOption({
  event, score, allowOptions = true, optionsEnabled = true, optionSymbol = null,
  allowedSymbols = [], thresholds = {}, optionContractLimit = DEFAULT_OPTION_CONTRACT_LIMIT,
  optionExpiryDaysMin = null, optionExpiryDaysMax = null, optionMaxPremium = null,
  nowMs = Date.now(),
} = {}) {
  if (!allowOptions) {
    return { enabled: false, accepted: false, reason: 'options disabled (allow_options=false)' };
  }
  if (!optionsEnabled) {
    return {
      enabled: true,
      accepted: false,
      reason: 'options disabled by PAPER_ENABLE_OPTIONS=false',
      assetClass: 'option',
      intent: 'none',
      underlying: event?.ticker ? String(event.ticker).trim().toUpperCase() : null,
      side: 'buy',
      contracts: clampContracts(optionContractLimit),
      eventId: Number.isInteger(event?.id) ? event.id : null,
      mode: 'disabled',
    };
  }

  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) };
  const scoreSummary = summarizeScore(score);
  const direction = scoreSummary.direction;
  const intent = intentForDirection(direction);
  const allowed = (allowedSymbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const eventTicker = String(event?.ticker ?? '').trim().toUpperCase();
  const contracts = clampContracts(optionContractLimit);

  const base = {
    enabled: true,
    assetClass: 'option',
    intent,
    underlying: eventTicker || null,
    optionSymbol: optionSymbol ? String(optionSymbol).trim().toUpperCase() : null,
    optionType: null,
    expiry: null,
    strike: null,
    side: 'buy', // open long call/put only
    contracts,
    optionMaxPremium: optionMaxPremium === null ? null : Number(optionMaxPremium),
    thresholds: t,
    score: scoreSummary,
    eventId: Number.isInteger(event?.id) ? event.id : null,
  };
  const reject = (reason) => ({ ...base, accepted: false, reason });

  if (intent === 'none') {
    return reject(`direction "${direction ?? '(none)'}" gives no option intent (need up/down)`);
  }
  if (!USABLE_PARSER_STATUSES.includes(scoreSummary.parserStatus)) {
    return reject(`parser_status "${scoreSummary.parserStatus ?? '(none)'}" not usable`);
  }
  const { confidence, impact, sentiment } = scoreSummary;
  if (confidence === null || confidence < t.minConfidence) {
    return reject(`confidence ${fmt(confidence)} below threshold ${t.minConfidence}`);
  }
  if (impact === null || impact < t.minImpact) {
    return reject(`impact ${fmt(impact)} below threshold ${t.minImpact}`);
  }
  if (intent === 'bullish_call' && (sentiment === null || sentiment < t.minSentiment)) {
    return reject(`sentiment ${fmt(sentiment)} below call threshold ${t.minSentiment}`);
  }
  if (intent === 'bearish_put' && (sentiment === null || sentiment > -t.minSentiment)) {
    return reject(`sentiment ${fmt(sentiment)} not below put threshold ${-t.minSentiment}`);
  }

  // No explicit contract: discovery/quote validation is required downstream.
  if (!base.optionSymbol) {
    return {
      ...base, accepted: true,
      reason: `PLAN ${intent}: buy ${contracts} ${intent === 'bullish_call' ? 'call' : 'put'}(s) on ` +
        `${base.underlying || '(underlying)'}; contract discovery and quote validation required`,
    };
  }

  // Explicit contract supplied: validate the OCC symbol.
  const occ = parseOccSymbol(base.optionSymbol);
  if (!occ) return reject(`invalid OCC option symbol "${base.optionSymbol}"`);
  base.optionType = occ.type;
  base.expiry = occ.expiry;
  base.strike = occ.strike;

  if (allowed.length > 0 && !allowed.includes(occ.root)) {
    return reject(`option underlying ${occ.root} not in allowed list [${allowed.join(',')}]`);
  }
  const wantType = intent === 'bullish_call' ? 'C' : 'P';
  if (occ.type !== wantType) {
    return reject(`option symbol is a ${occ.type === 'C' ? 'call' : 'put'} but intent ${intent} needs a ${wantType === 'C' ? 'call' : 'put'}`);
  }
  const dte = daysUntil(occ.expiry, nowMs);
  if (dte !== null && dte < 0) return reject(`option ${base.optionSymbol} already expired`);
  if (optionExpiryDaysMin !== null && dte !== null && dte < Number(optionExpiryDaysMin)) {
    return reject(`expiry ${occ.expiry} (${dte}d) below --option-expiry-days-min ${optionExpiryDaysMin}`);
  }
  if (optionExpiryDaysMax !== null && dte !== null && dte > Number(optionExpiryDaysMax)) {
    return reject(`expiry ${occ.expiry} (${dte}d) above --option-expiry-days-max ${optionExpiryDaysMax}`);
  }

  return {
    ...base, accepted: true,
    reason: `${intent}: buy ${contracts} ${base.optionSymbol} (${occ.type === 'C' ? 'call' : 'put'} ` +
      `strike ${occ.strike} exp ${occ.expiry})`,
  };
}
