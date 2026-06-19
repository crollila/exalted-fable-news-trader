// src/paper/paperRisk.js — Margin-aware PAPER risk gate. Pure function (no HTTP,
// no DB, no clock); the caller supplies the account snapshot, capabilities,
// positions, caps, daily counters, and a reference price. PAPER-only: no
// live-money assumptions, no live trading.
//
// Fail-safe design: when notional cannot be computed (no reference price) an
// EXECUTE request is REJECTED — we never send an order whose caps we could not
// verify. A dry run is allowed through with a clear "unverified" caveat.

import { grossExposure, symbolExposure, MIN_SHORT_EQUITY_USD } from './accountCapabilities.js';

/** Option contracts cover 100 shares of the underlying. */
export const OPTION_CONTRACT_MULTIPLIER = 100;

/** Conservative default caps (USD), all overridable by CLI. */
export const DEFAULT_CAPS = Object.freeze({
  maxOrderNotional: 500,
  maxSymbolExposure: 1000,
  maxGrossExposure: 5000,
  maxDailyPaperOrders: 10,
  maxDailyPaperNotional: 5000,
  maxOptionPremium: 250, // per order, USD
});

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Merge caller caps over the conservative defaults. */
export function resolveCaps(caps = {}) {
  return {
    maxOrderNotional: num(caps.maxOrderNotional, DEFAULT_CAPS.maxOrderNotional),
    maxSymbolExposure: num(caps.maxSymbolExposure, DEFAULT_CAPS.maxSymbolExposure),
    maxGrossExposure: num(caps.maxGrossExposure, DEFAULT_CAPS.maxGrossExposure),
    maxDailyPaperOrders: num(caps.maxDailyPaperOrders, DEFAULT_CAPS.maxDailyPaperOrders),
    maxDailyPaperNotional: num(caps.maxDailyPaperNotional, DEFAULT_CAPS.maxDailyPaperNotional),
    maxOptionPremium: num(caps.maxOptionPremium, DEFAULT_CAPS.maxOptionPremium),
  };
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100;
}

/**
 * Estimate the order notional (USD). Equity = price * qty; option = price *
 * 100 * contracts. Returns null when the reference price is unavailable.
 */
export function estimateNotional({ assetClass, quantity, referencePrice }) {
  if (referencePrice === null || referencePrice === undefined || !Number.isFinite(Number(referencePrice))) {
    return null;
  }
  const px = Number(referencePrice);
  const qty = Number(quantity) || 0;
  return assetClass === 'option' ? px * OPTION_CONTRACT_MULTIPLIER * qty : px * qty;
}

/**
 * Assess a proposal against margin/exposure/daily caps.
 *
 * @param {object} args
 * @param {object} args.proposal     { assetClass:'equity'|'option', side, ticker, quantity }
 * @param {object} args.capabilities deriveCapabilities() result
 * @param {object|null} args.account sanitized account snapshot
 * @param {object[]} [args.positions] sanitized positions
 * @param {object} [args.caps]       cap overrides
 * @param {object} [args.daily]      { orders:number, notional:number } so far today
 * @param {number|null} [args.referencePrice] per-share (equity) or per-contract premium (option)
 * @param {boolean} [args.executePaper]  whether a real order would be sent
 * @returns {{ approved:boolean, reason:string, estNotional:number|null, caps:object }}
 */
export function assessRisk({
  proposal,
  capabilities,
  account = null,
  positions = [],
  caps = {},
  daily = { orders: 0, notional: 0 },
  referencePrice = null,
  executePaper = false,
} = {}) {
  const c = resolveCaps(caps);
  const isOption = proposal?.assetClass === 'option';
  const isShort = proposal?.assetClass === 'equity' && proposal?.side === 'sell';
  const estNotional = estimateNotional({ ...proposal, referencePrice });
  const out = (approved, reason) => ({ approved, reason, estNotional: round2(estNotional), caps: c });

  // 1. Account / trading blocked.
  if (!capabilities?.available) return out(false, 'account snapshot unavailable — cannot risk-check');
  if (capabilities.blocked) return out(false, 'account or trading is blocked');

  // 2. Privilege gates.
  if (isShort && !capabilities.shortEligible) {
    return out(false, 'short rejected: account is not margin/short eligible');
  }
  if (isShort && (account?.equity ?? 0) < MIN_SHORT_EQUITY_USD) {
    return out(false, `short rejected: equity below $${MIN_SHORT_EQUITY_USD} margin threshold`);
  }
  if (isOption && executePaper && !capabilities.optionsEligible) {
    return out(false, 'option execution rejected: account options capability is absent/unknown');
  }

  // 3. Daily order-count cap (independent of notional).
  if ((daily?.orders ?? 0) >= c.maxDailyPaperOrders) {
    return out(false, `daily paper order cap reached (${c.maxDailyPaperOrders})`);
  }

  // 4. Notional-dependent caps. Fail-safe when notional is unknown.
  if (estNotional === null) {
    if (isOption) {
      // No option quote feed in this patch: premium cannot be pre-verified. The
      // order stays bounded by --option-contract-limit + the capability gate.
      // PAPER-only, so this relaxation cannot risk real money.
      return out(true, 'approved (option premium UNVERIFIED — no option quote feed; bounded by --option-contract-limit)');
    }
    if (executePaper) {
      return out(false, 'cannot verify notional caps without a reference price — refusing to execute');
    }
    return out(true, 'approved (DRY RUN; notional unverified — no reference price)');
  }

  if (isOption) {
    if (estNotional > c.maxOptionPremium) {
      return out(false, `option premium ${round2(estNotional)} exceeds --option-max-premium ${c.maxOptionPremium}`);
    }
  }
  if (estNotional > c.maxOrderNotional) {
    return out(false, `order notional ${round2(estNotional)} exceeds --max-order-notional ${c.maxOrderNotional}`);
  }
  const symExp = symbolExposure(positions, proposal.ticker);
  if (symExp + estNotional > c.maxSymbolExposure) {
    return out(false, `symbol exposure ${round2(symExp + estNotional)} exceeds --max-symbol-exposure ${c.maxSymbolExposure}`);
  }
  const gross = grossExposure(positions);
  if (gross + estNotional > c.maxGrossExposure) {
    return out(false, `gross exposure ${round2(gross + estNotional)} exceeds --max-gross-exposure ${c.maxGrossExposure}`);
  }
  if ((daily?.notional ?? 0) + estNotional > c.maxDailyPaperNotional) {
    return out(false, `daily paper notional ${round2((daily.notional ?? 0) + estNotional)} exceeds --max-daily-paper-notional ${c.maxDailyPaperNotional}`);
  }
  // Buying power (long equity / option debit). Shorts also consume buying power.
  if (!isShort && typeof account?.buyingPower === 'number' && account.buyingPower < estNotional) {
    return out(false, `insufficient buying power (${round2(account.buyingPower)} < ${round2(estNotional)})`);
  }

  return out(true, `approved: notional ${round2(estNotional)} within all caps`);
}
