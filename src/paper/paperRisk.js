// src/paper/paperRisk.js — Margin-aware PAPER risk gate. Pure function (no HTTP,
// no DB, no clock); the caller supplies the account snapshot, capabilities,
// positions, caps, daily counters, and a reference price. PAPER-only: no
// live-money assumptions, no live trading.
//
// Fail-safe design: when notional cannot be computed (no reference price) an
// EXECUTE request is REJECTED — we never send an order whose caps we could not
// verify. A dry run is allowed through with a clear "unverified" caveat.

import { grossExposure, symbolExposure, MIN_SHORT_EQUITY_USD } from './accountCapabilities.js';

/** Conservative default caps (USD), all overridable by CLI. */
export const DEFAULT_CAPS = Object.freeze({
  maxOrderNotional: 500,
  maxSymbolExposure: 1000,
  maxGrossExposure: 5000,
  maxDailyPaperOrders: 10,
  maxDailyPaperNotional: 5000,
});

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function posNumOrNull(value) {
  const n = numOrNull(value);
  return n !== null && n > 0 ? n : null;
}

/** Merge caller caps over the conservative defaults. */
export function resolveCaps(caps = {}) {
  return {
    maxOrderNotional: num(caps.maxOrderNotional, DEFAULT_CAPS.maxOrderNotional),
    maxSymbolExposure: num(caps.maxSymbolExposure, DEFAULT_CAPS.maxSymbolExposure),
    maxGrossExposure: num(caps.maxGrossExposure, DEFAULT_CAPS.maxGrossExposure),
    maxDailyPaperOrders: num(caps.maxDailyPaperOrders, DEFAULT_CAPS.maxDailyPaperOrders),
    maxDailyPaperNotional: num(caps.maxDailyPaperNotional, DEFAULT_CAPS.maxDailyPaperNotional),
  };
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100;
}

function hasOwnCap(caps, key) {
  return Object.prototype.hasOwnProperty.call(caps ?? {}, key);
}

function capSourceLabel(source) {
  return String(source ?? 'default').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
}

/**
 * Resolve learned-equity caps before final risk assessment. The key alignment
 * rule is that the legacy/default fixed-dollar order cap is not allowed to be
 * the hidden limiter for a valid portfolio-weight target. Explicit user caps
 * still apply, and the learned max target weight remains the hard percentage
 * ceiling.
 */
export function resolveLearnedEquityEffectiveCaps({
  caps = {},
  account = null,
  maxTargetWeight = null,
} = {}) {
  const resolved = resolveCaps(caps);
  const accountEquity = posNumOrNull(account?.equity ?? account?.portfolioValue);
  const weight = posNumOrNull(maxTargetWeight);
  const learnedPctCap =
    accountEquity !== null && weight !== null
      ? Math.round(accountEquity * weight * 100) / 100
      : null;
  const explicitOrderCap = hasOwnCap(caps, 'maxOrderNotional')
    ? posNumOrNull(caps.maxOrderNotional)
    : null;

  let effectiveOrderCap = resolved.maxOrderNotional;
  let orderCapSource = 'default_fixed_dollar';
  if (learnedPctCap !== null && explicitOrderCap !== null) {
    if (explicitOrderCap <= learnedPctCap) {
      effectiveOrderCap = explicitOrderCap;
      orderCapSource = 'explicit_dollar_cap_tighter_than_learned_max_weight';
    } else {
      effectiveOrderCap = learnedPctCap;
      orderCapSource = 'learned_max_weight_tighter_than_explicit_dollar_cap';
    }
  } else if (learnedPctCap !== null) {
    effectiveOrderCap = learnedPctCap;
    orderCapSource = 'learned_max_weight_no_explicit_dollar_cap';
  } else if (explicitOrderCap !== null) {
    effectiveOrderCap = explicitOrderCap;
    orderCapSource = 'explicit_dollar_cap';
  }

  return {
    caps: { ...resolved, maxOrderNotional: effectiveOrderCap },
    capSources: {
      maxOrderNotional: {
        source: orderCapSource,
        value: round2(effectiveOrderCap),
        accountEquity: round2(accountEquity),
        maxTargetWeight: weight,
        learnedPercentCap: round2(learnedPctCap),
        explicitDollarCap: round2(explicitOrderCap),
        defaultDollarCap: DEFAULT_CAPS.maxOrderNotional,
      },
    },
  };
}

/**
 * Estimate the order notional (USD): price * qty. Returns null when the
 * reference price is unavailable.
 */
export function estimateNotional({ quantity, referencePrice }) {
  if (referencePrice === null || referencePrice === undefined || !Number.isFinite(Number(referencePrice))) {
    return null;
  }
  const px = Number(referencePrice);
  const qty = Number(quantity) || 0;
  return px * qty;
}

function wholeSharesForNotional(notional, referencePrice) {
  const n = Number(notional);
  const px = Number(referencePrice);
  if (!Number.isFinite(n) || !Number.isFinite(px) || px <= 0) return null;
  return Math.max(0, Math.floor(n / px));
}

/**
 * Lower a learned PAPER equity quantity to the largest whole-share amount that
 * can still satisfy deterministic notional-style caps. This never raises size
 * and does not replace assessRisk(), which still performs privilege checks and
 * rejects any final proposal that cannot be verified.
 */
export function clampEquityQuantityToCaps({
  proposal,
  account = null,
  positions = [],
  caps = {},
  capSources = {},
  daily = { orders: 0, notional: 0 },
  referencePrice = null,
  marginEnabled = true,
} = {}) {
  const c = resolveCaps(caps);
  const requestedQuantity = Math.max(0, Math.floor(Number(proposal?.quantity) || 0));
  const capReport = [];
  const clampReasons = [];
  const out = (quantity, reason) => ({
    quantity,
    requestedQuantity,
    clamped: quantity < requestedQuantity,
    reason,
    caps: c,
    capReport,
    clampReasons,
  });
  if (proposal?.assetClass !== 'equity' || requestedQuantity <= 0) {
    return out(requestedQuantity, 'not an equity quantity clamp candidate');
  }
  if (referencePrice === null || referencePrice === undefined || !Number.isFinite(Number(referencePrice)) || Number(referencePrice) <= 0) {
    const reason = 'reference price unavailable for risk-cap quantity clamp';
    clampReasons.push(reason);
    capReport.push({
      key: 'referencePrice',
      label: 'reference price',
      source: 'market_data',
      value: null,
      remainingNotional: null,
      allowedQuantity: 0,
      clamped: requestedQuantity > 0,
      reason,
    });
    return out(0, reason);
  }
  if ((daily?.orders ?? 0) >= c.maxDailyPaperOrders) {
    const reason = `daily paper order cap reached (${c.maxDailyPaperOrders})`;
    clampReasons.push(reason);
    capReport.push({
      key: 'maxDailyPaperOrders',
      label: 'daily paper order count',
      source: 'maxDailyPaperOrders',
      value: c.maxDailyPaperOrders,
      used: Number(daily?.orders ?? 0),
      remaining: 0,
      remainingNotional: 0,
      allowedQuantity: 0,
      clamped: true,
      reason,
    });
    return out(0, reason);
  }

  const candidates = [requestedQuantity];
  const addNotionalLimit = (key, label, notional, { source = key, capValue = notional, used = null } = {}) => {
    const shares = wholeSharesForNotional(notional, referencePrice);
    if (shares === null) return;
    candidates.push(shares);
    const clamped = shares < requestedQuantity;
    const cleanLabel = String(label);
    const reason = clamped
      ? `${cleanLabel} cap allows ${shares} share(s) at reference price $${round2(referencePrice)?.toFixed(2)}`
      : `${cleanLabel} cap allows requested quantity (${requestedQuantity} share(s))`;
    const report = {
      key,
      label: cleanLabel,
      source: capSourceLabel(source),
      value: round2(capValue),
      used: round2(used),
      remainingNotional: round2(notional),
      allowedQuantity: shares,
      clamped,
      reason,
    };
    capReport.push(report);
    if (clamped) clampReasons.push(reason);
  };

  addNotionalLimit('maxOrderNotional', 'max order notional', c.maxOrderNotional, {
    source: capSources.maxOrderNotional?.source ?? 'maxOrderNotional',
    capValue: c.maxOrderNotional,
  });
  addNotionalLimit('maxDailyPaperNotional', 'remaining daily paper notional', c.maxDailyPaperNotional - (daily?.notional ?? 0), {
    source: 'maxDailyPaperNotional',
    capValue: c.maxDailyPaperNotional,
    used: daily?.notional ?? 0,
  });
  const currentSymbolExposure = symbolExposure(positions, proposal.ticker);
  addNotionalLimit('maxSymbolExposure', 'remaining symbol exposure', c.maxSymbolExposure - currentSymbolExposure, {
    source: 'maxSymbolExposure',
    capValue: c.maxSymbolExposure,
    used: currentSymbolExposure,
  });
  const currentGrossExposure = grossExposure(positions);
  addNotionalLimit('maxGrossExposure', 'remaining gross exposure', c.maxGrossExposure - currentGrossExposure, {
    source: 'maxGrossExposure',
    capValue: c.maxGrossExposure,
    used: currentGrossExposure,
  });

  const isShort = proposal.side === 'sell';
  const buyingPower =
    marginEnabled && typeof account?.buyingPower === 'number'
      ? account.buyingPower
      : typeof account?.cash === 'number'
        ? account.cash
        : null;
  if (!isShort && typeof buyingPower === 'number') {
    addNotionalLimit('buyingPower', marginEnabled ? 'buying power' : 'cash buying power', buyingPower, {
      source: marginEnabled ? 'broker_buying_power' : 'cash',
      capValue: buyingPower,
    });
  }

  const quantity = Math.max(0, Math.min(...candidates.filter((n) => Number.isFinite(n))));
  if (quantity < requestedQuantity) {
    const reason = `learned equity quantity ${requestedQuantity} clamped to ${quantity} by deterministic risk caps`;
    return out(quantity, reason);
  }
  return out(quantity, 'learned equity quantity within deterministic risk caps');
}

/**
 * Assess a proposal against margin/exposure/daily caps.
 *
 * @param {object} args
 * @param {object} args.proposal     { assetClass:'equity', side, ticker, quantity }
 * @param {object} args.capabilities deriveCapabilities() result
 * @param {object|null} args.account sanitized account snapshot
 * @param {object[]} [args.positions] sanitized positions
 * @param {object|null} [args.asset]  sanitized asset snapshot for shortability checks
 * @param {object} [args.caps]       cap overrides
 * @param {object} [args.daily]      { orders:number, notional:number } so far today
 * @param {number|null} [args.referencePrice] per-share reference price
 * @param {boolean} [args.executePaper]  whether a real order would be sent
 * @param {boolean} [args.marginEnabled] central PAPER_ENABLE_MARGIN gate
 * @returns {{ approved:boolean, reason:string, estNotional:number|null, caps:object }}
 */
export function assessRisk({
  proposal,
  capabilities,
  account = null,
  positions = [],
  asset = null,
  caps = {},
  daily = { orders: 0, notional: 0 },
  referencePrice = null,
  executePaper = false,
  marginEnabled = true,
} = {}) {
  const c = resolveCaps(caps);
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
  if (isShort && !marginEnabled) {
    return out(false, 'short rejected: PAPER_ENABLE_MARGIN=false (margin disabled)');
  }
  if (isShort) {
    if (!asset) return out(false, 'short rejected: asset shortability data unavailable');
    if (asset.tradable !== true) return out(false, 'short rejected: asset is not tradable');
    if (asset.shortable !== true) return out(false, 'short rejected: asset is not shortable');
    // Require an explicit easy-to-borrow=true; unknown/null fails closed (no short).
    if (asset.easyToBorrow !== true) return out(false, 'short rejected: asset is not confirmed easy-to-borrow');
  }
  if (isShort && (account?.equity ?? 0) < MIN_SHORT_EQUITY_USD) {
    return out(false, `short rejected: equity below $${MIN_SHORT_EQUITY_USD} margin threshold`);
  }

  // 3. Daily order-count cap (independent of notional).
  if ((daily?.orders ?? 0) >= c.maxDailyPaperOrders) {
    return out(false, `daily paper order cap reached (${c.maxDailyPaperOrders})`);
  }

  // 4. Notional-dependent caps. Fail-safe when notional is unknown.
  if (estNotional === null) {
    if (executePaper) {
      return out(false, 'cannot verify notional caps without a reference price — refusing to execute');
    }
    return out(true, 'approved (DRY RUN; notional unverified — no reference price)');
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
  // Buying power (long equity / option debit). When margin is disabled, use
  // cash only; when enabled, use the broker-reported paper buying power.
  const buyingPower =
    marginEnabled && typeof account?.buyingPower === 'number'
      ? account.buyingPower
      : typeof account?.cash === 'number'
        ? account.cash
        : null;
  if (!isShort && typeof buyingPower === 'number' && buyingPower < estNotional) {
    return out(false, `insufficient buying power (${round2(buyingPower)} < ${round2(estNotional)})`);
  }

  return out(true, `approved: notional ${round2(estNotional)} within all caps`);
}
