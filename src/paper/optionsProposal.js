// src/paper/optionsProposal.js — PAPER options proposal (Phase 5 advanced).
//
// SCOPE — deliberately bounded and safe:
// - Single-leg LONG options only: BUY a call (bullish) or a put (bearish).
//   No spreads, no multi-leg, no auto-rolls, no selling uncovered options.
//   Selling is only ever to CLOSE an existing option position (handled by the
//   caller against live positions; this module proposes opens).
// - EXPLICIT --option-symbol (OCC) ONLY — there is no contract discovery in
//   this patch, so execution requires the operator to name the exact contract.
// - DEFAULT plan_only: a proposal never executes unless --options-mode
//   execute_paper is explicitly chosen (and the caller still requires
//   --execute-paper + a verified options capability).
// - PURE function (no HTTP, no DB). The risk/premium/exposure checks live in
//   paperRisk.js; the capability gate lives in the caller.

import { OCC_OPTION_RE } from './alpacaPaperClient.js';
import { summarizeScore, DEFAULT_THRESHOLDS, USABLE_PARSER_STATUSES, clampQty } from './paperTradeProposal.js';

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
 * decision. `enabled:false` means --allow-options was not set (skip silently).
 *
 * @param {object} args
 * @param {{id?:number, ticker?:string}} args.event
 * @param {object} args.score
 * @param {boolean} [args.allowOptions]
 * @param {'plan_only'|'execute_paper'} [args.optionsMode]
 * @param {string|null} [args.optionSymbol]   explicit OCC symbol (required to execute)
 * @param {string[]} [args.allowedSymbols]
 * @param {object} [args.thresholds]
 * @param {number} [args.optionContractLimit]
 * @param {number|null} [args.optionExpiryDaysMin]
 * @param {number|null} [args.optionExpiryDaysMax]
 * @param {number|null} [args.optionMaxPremium]
 * @param {number} [args.nowMs]  injectable clock for expiry checks
 */
export function proposeOption({
  event, score, allowOptions = false, optionsMode = 'plan_only', optionSymbol = null,
  allowedSymbols = [], thresholds = {}, optionContractLimit = DEFAULT_OPTION_CONTRACT_LIMIT,
  optionExpiryDaysMin = null, optionExpiryDaysMax = null, optionMaxPremium = null,
  nowMs = Date.now(),
} = {}) {
  if (!allowOptions) {
    return { enabled: false, accepted: false, reason: 'options disabled (--allow-options not set)' };
  }

  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) };
  const scoreSummary = summarizeScore(score);
  const direction = scoreSummary.direction;
  const intent = intentForDirection(direction);
  const planOnly = optionsMode !== 'execute_paper';
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
    mode: planOnly ? 'plan_only' : 'execute_paper',
    planOnly,
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

  // No explicit contract: plan-only is fine; execution is refused.
  if (!base.optionSymbol) {
    if (!planOnly) {
      return reject('option execution requires --option-symbol (no contract discovery in this patch)');
    }
    return {
      ...base, accepted: true,
      reason: `PLAN ${intent}: buy ${contracts} ${intent === 'bullish_call' ? 'call' : 'put'}(s) on ` +
        `${base.underlying || '(underlying)'}; provide --option-symbol to execute`,
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
      `strike ${occ.strike} exp ${occ.expiry})${planOnly ? ' [plan_only]' : ''}`,
  };
}
