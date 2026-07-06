// src/paper/optionContracts.js - Minimal PAPER options selection/validation.
//
// Scope is intentionally narrow: defined-risk single-leg LONG calls/puts only.
// No naked shorts, spreads, covered calls, assignment/exercise, or complex
// strategy automation. This module is pure except enrichOptionProposal(), whose
// only side effects are injected read-only broker/data calls.

import { parseOccSymbol } from './optionsProposal.js';

export const DEFAULT_OPTION_EXPIRY_DAYS_MIN = 7;
export const DEFAULT_OPTION_EXPIRY_DAYS_MAX = 45;
export const DEFAULT_MIN_OPTION_OPEN_INTEREST = 1;
export const DEFAULT_MAX_QUOTE_SPREAD_PCT = 0.5;
export const DEFAULT_OPTION_EXIT_POLICY =
  'paper research exit: close at +50% premium, -50% premium, or before expiration; review EOD';

function ymdFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDaysYmd(nowMs, days) {
  return ymdFromMs(Number(nowMs) + Number(days) * 86_400_000);
}

function daysUntil(expiry, nowMs) {
  const exp = Date.parse(`${expiry}T00:00:00.000Z`);
  if (!Number.isFinite(exp)) return null;
  return Math.round((exp - Number(nowMs)) / 86_400_000);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function reject(base, reason) {
  return { ...base, accepted: false, reason };
}

export function rightForIntent(intent) {
  if (intent === 'bullish_call') return 'call';
  if (intent === 'bearish_put') return 'put';
  return null;
}

export function strategyForRight(right) {
  if (right === 'call') return 'long_call';
  if (right === 'put') return 'long_put';
  return null;
}

export function optionExpirationWindow({
  nowMs = Date.now(),
  minDays = DEFAULT_OPTION_EXPIRY_DAYS_MIN,
  maxDays = DEFAULT_OPTION_EXPIRY_DAYS_MAX,
} = {}) {
  const min = Number.isFinite(Number(minDays)) ? Number(minDays) : DEFAULT_OPTION_EXPIRY_DAYS_MIN;
  const max = Number.isFinite(Number(maxDays)) ? Number(maxDays) : DEFAULT_OPTION_EXPIRY_DAYS_MAX;
  return {
    minDays: min,
    maxDays: Math.max(min, max),
    expirationDateGte: addDaysYmd(nowMs, min),
    expirationDateLte: addDaysYmd(nowMs, Math.max(min, max)),
  };
}

export function validateUnderlyingAsset(asset, underlying) {
  const symbol = String(underlying ?? '').trim().toUpperCase();
  if (!asset) return { ok: false, reason: 'underlying asset data unavailable' };
  if (asset.symbol !== symbol) return { ok: false, reason: `underlying asset mismatch (${asset.symbol ?? '?'})` };
  if (asset.status && asset.status !== 'active') {
    return { ok: false, reason: `underlying asset status is ${asset.status}` };
  }
  if (asset.tradable !== true) return { ok: false, reason: 'underlying asset is not tradable' };
  return { ok: true, reason: 'underlying asset tradable' };
}

function contractRight(contract) {
  const t = String(contract?.type ?? '').trim().toLowerCase();
  if (t === 'call' || t === 'c') return 'call';
  if (t === 'put' || t === 'p') return 'put';
  const occ = parseOccSymbol(contract?.symbol);
  if (occ?.type === 'C') return 'call';
  if (occ?.type === 'P') return 'put';
  return null;
}

export function eligibleOptionContracts(
  contracts = [],
  {
    underlying,
    right,
    nowMs = Date.now(),
    minDays = DEFAULT_OPTION_EXPIRY_DAYS_MIN,
    maxDays = DEFAULT_OPTION_EXPIRY_DAYS_MAX,
    optionSymbol = null,
    minOpenInterest = DEFAULT_MIN_OPTION_OPEN_INTEREST,
  } = {}
) {
  const symbol = String(underlying ?? '').trim().toUpperCase();
  const exact = optionSymbol ? String(optionSymbol).trim().toUpperCase() : null;
  return (contracts ?? [])
    .map((contract) => ({ contract, occ: parseOccSymbol(contract?.symbol) }))
    .filter(({ contract, occ }) => {
      if (!occ) return false;
      if (exact && String(contract?.symbol ?? '').toUpperCase() !== exact) return false;
      if (String(contract?.underlyingSymbol ?? occ.root).toUpperCase() !== symbol) return false;
      if (contract.status && contract.status !== 'active') return false;
      if (contract.tradable !== true) return false;
      if (contractRight(contract) !== right) return false;
      if (num(contract.strikePrice ?? occ.strike) === null || num(contract.strikePrice ?? occ.strike) <= 0) return false;
      const dte = daysUntil(contract.expirationDate ?? occ.expiry, nowMs);
      if (dte !== null && dte < Number(minDays)) return false;
      if (dte !== null && dte > Number(maxDays)) return false;
      if (contract.openInterest !== null && contract.openInterest !== undefined && Number(contract.openInterest) < minOpenInterest) {
        return false;
      }
      return true;
    })
    .map(({ contract, occ }) => ({
      ...contract,
      symbol: String(contract.symbol).toUpperCase(),
      underlyingSymbol: String(contract.underlyingSymbol ?? occ.root).toUpperCase(),
      expirationDate: contract.expirationDate ?? occ.expiry,
      strikePrice: num(contract.strikePrice ?? occ.strike),
      type: right,
      dte: daysUntil(contract.expirationDate ?? occ.expiry, nowMs),
    }));
}

export function chooseOptionContract(contracts = [], opts = {}) {
  const eligible = eligibleOptionContracts(contracts, opts);
  if (eligible.length === 0) {
    return { accepted: false, reason: 'no eligible tradable option contract found', contract: null };
  }
  const targetDte = (Number(opts.minDays ?? DEFAULT_OPTION_EXPIRY_DAYS_MIN) + Number(opts.maxDays ?? DEFAULT_OPTION_EXPIRY_DAYS_MAX)) / 2;
  eligible.sort((a, b) => {
    const oi = (b.openInterest ?? -1) - (a.openInterest ?? -1);
    if (oi !== 0) return oi;
    const ad = Math.abs((a.dte ?? targetDte) - targetDte);
    const bd = Math.abs((b.dte ?? targetDte) - targetDte);
    if (ad !== bd) return ad - bd;
    return a.strikePrice - b.strikePrice;
  });
  return { accepted: true, reason: 'eligible tradable option contract selected', contract: eligible[0] };
}

export function validateOptionQuote(
  quote,
  {
    contracts = 1,
    maxPremium = null,
    maxSpreadPct = DEFAULT_MAX_QUOTE_SPREAD_PCT,
  } = {}
) {
  const bid = num(quote?.bid);
  const ask = num(quote?.ask);
  if (bid === null || bid <= 0) return { accepted: false, reason: 'option quote missing positive bid' };
  if (ask === null || ask <= 0) return { accepted: false, reason: 'option quote missing positive ask' };
  if (ask < bid) return { accepted: false, reason: 'option quote ask is below bid' };
  const mid = quote?.mid !== null && quote?.mid !== undefined ? num(quote.mid) : (bid + ask) / 2;
  const spreadPct = mid && mid > 0 ? (ask - bid) / mid : null;
  if (spreadPct !== null && spreadPct > maxSpreadPct) {
    return { accepted: false, reason: `option quote spread ${Math.round(spreadPct * 100)}% exceeds ${Math.round(maxSpreadPct * 100)}% cap` };
  }
  const quantity = Number.parseInt(contracts, 10) || 1;
  const notional = Math.round(ask * 100 * quantity * 100) / 100;
  if (maxPremium !== null && maxPremium !== undefined && notional > Number(maxPremium)) {
    return { accepted: false, reason: `option premium ${notional} exceeds --option-max-premium ${Number(maxPremium)}` };
  }
  return {
    accepted: true,
    reason: `validated quote bid ${bid} ask ${ask}`,
    bid,
    ask,
    mid: Math.round(Number(mid) * 10000) / 10000,
    notional,
  };
}

export async function enrichOptionProposal({
  proposal,
  paperClient = null,
  underlyingAsset = null,
  optionSymbol = null,
  optionMaxPremium = null,
  optionExpiryDaysMin = null,
  optionExpiryDaysMax = null,
  nowMs = Date.now(),
} = {}) {
  if (!proposal?.enabled || !proposal?.accepted) return proposal;
  const underlying = String(proposal.underlying ?? '').trim().toUpperCase();
  const right = rightForIntent(proposal.intent);
  const strategy = strategyForRight(right);
  const base = { ...proposal, right, strategy, exitPolicy: DEFAULT_OPTION_EXIT_POLICY };
  if (!paperClient) {
    return reject(base, 'option contract discovery unavailable (paper client not configured)');
  }
  if (!underlying || !right || !strategy) {
    return reject(base, 'option intent requires an underlying and call/put direction');
  }

  let asset = underlyingAsset;
  try {
    asset = asset ?? await paperClient.getAsset(underlying);
  } catch (err) {
    return reject(base, `underlying asset validation failed: ${err.message}`);
  }
  const assetCheck = validateUnderlyingAsset(asset, underlying);
  if (!assetCheck.ok) return reject(base, assetCheck.reason);

  const window = optionExpirationWindow({
    nowMs,
    minDays: optionExpiryDaysMin ?? DEFAULT_OPTION_EXPIRY_DAYS_MIN,
    maxDays: optionExpiryDaysMax ?? DEFAULT_OPTION_EXPIRY_DAYS_MAX,
  });

  let contractResult;
  try {
    const discovered = await paperClient.getOptionContracts({
      underlyingSymbols: [underlying],
      expirationDateGte: window.expirationDateGte,
      expirationDateLte: window.expirationDateLte,
      type: right,
      status: 'active',
      limit: 100,
    });
    contractResult = chooseOptionContract(discovered.contracts, {
      underlying,
      right,
      nowMs,
      minDays: window.minDays,
      maxDays: window.maxDays,
      optionSymbol: optionSymbol ?? proposal.optionSymbol,
    });
  } catch (err) {
    return reject(base, `option contract discovery failed: ${err.message}`);
  }
  if (!contractResult.accepted) return reject(base, contractResult.reason);

  const contract = contractResult.contract;
  let quote;
  try {
    quote = await paperClient.getOptionQuote({
      underlyingSymbol: underlying,
      optionSymbol: contract.symbol,
    });
  } catch (err) {
    return reject(base, `option quote unavailable: ${err.message}`);
  }
  const quoteCheck = validateOptionQuote(quote, {
    contracts: proposal.contracts,
    maxPremium: optionMaxPremium ?? proposal.optionMaxPremium,
  });
  if (!quoteCheck.accepted) return reject(base, quoteCheck.reason);

  return {
    ...base,
    accepted: true,
    optionSymbol: contract.symbol,
    optionType: right === 'call' ? 'C' : 'P',
    expiry: contract.expirationDate,
    strike: contract.strikePrice,
    premiumEntry: quoteCheck.ask,
    notionalEntry: quoteCheck.notional,
    quoteBid: quoteCheck.bid,
    quoteAsk: quoteCheck.ask,
    quoteMid: quoteCheck.mid,
    strategyRationale: `${strategy}: ${proposal.intent} on ${underlying}; tradable contract and quote validated`,
    reason:
      `${proposal.intent}: buy ${proposal.contracts} ${contract.symbol} ` +
      `(${right} strike ${contract.strikePrice} exp ${contract.expirationDate}) ` +
      `premium ${quoteCheck.ask} notional ${quoteCheck.notional}`,
  };
}
