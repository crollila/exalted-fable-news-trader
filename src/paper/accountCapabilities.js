// src/paper/accountCapabilities.js — Derive PAPER trading capabilities from a
// sanitized Alpaca account snapshot + positions. Pure functions only (no HTTP,
// no DB, no clock). No live-money assumptions — this reads paper account state.

/** Reg-T minimum equity to short / use margin (USD). Conservative paper gate. */
export const MIN_SHORT_EQUITY_USD = 2000;

/**
 * Infer capabilities from a sanitized account snapshot (see
 * alpacaPaperClient.sanitizeAccount). Unknown fields fail CLOSED for the
 * privileged capabilities (shorts/options) — we never assume a permission the
 * account did not clearly report.
 *
 * @param {object|null} account
 * @returns {{
 *   available: boolean, blocked: boolean,
 *   marginEligible: boolean, shortEligible: boolean,
 *   optionsEligible: boolean, optionsLevel: number|null,
 *   equity: number|null, buyingPower: number|null, multiplier: number|null,
 *   notes: string[],
 * }}
 */
export function deriveCapabilities(account) {
  const notes = [];
  if (!account) {
    return {
      available: false, blocked: true, marginEligible: false, shortEligible: false,
      optionsEligible: false, optionsLevel: null, equity: null, buyingPower: null,
      multiplier: null, notes: ['account snapshot unavailable'],
    };
  }

  const blocked = account.tradingBlocked === true || account.accountBlocked === true;
  if (blocked) notes.push('account or trading is blocked');

  const active = account.status === null || account.status === 'ACTIVE';
  if (!active) notes.push(`account status is ${account.status}`);

  const multiplier = account.multiplier;
  // multiplier 1 = cash account; >= 2 = margin (Reg-T) / PDT.
  const isMargin = typeof multiplier === 'number' && multiplier >= 2;
  const equity = account.equity;
  const equityOk = typeof equity === 'number' && equity >= MIN_SHORT_EQUITY_USD;

  const marginEligible = !blocked && active && isMargin;
  const shortEligible = marginEligible && equityOk;
  if (isMargin && !equityOk) notes.push(`equity below $${MIN_SHORT_EQUITY_USD} short/margin minimum`);
  if (!isMargin) notes.push('cash account (multiplier < 2): no shorting/margin');

  // Options: require a clearly-reported approval/trading level >= 1. Absent or
  // unknown => not eligible (fail closed).
  const optionsLevel =
    typeof account.optionsTradingLevel === 'number'
      ? account.optionsTradingLevel
      : typeof account.optionsApprovedLevel === 'number'
        ? account.optionsApprovedLevel
        : null;
  const optionsEligible = !blocked && active && typeof optionsLevel === 'number' && optionsLevel >= 1;
  if (optionsLevel === null) notes.push('options approval level unknown (options execution will be refused)');

  return {
    available: true, blocked, marginEligible, shortEligible, optionsEligible, optionsLevel,
    equity, buyingPower: account.buyingPower, multiplier, notes,
  };
}

/** Sum of absolute position market values = gross exposure (USD). */
export function grossExposure(positions = []) {
  return (positions ?? []).reduce((sum, p) => sum + Math.abs(Number(p?.marketValue) || 0), 0);
}

/** Absolute market value already held in one symbol (USD). */
export function symbolExposure(positions = [], symbol) {
  const sym = String(symbol ?? '').toUpperCase();
  return (positions ?? [])
    .filter((p) => String(p?.symbol ?? '').toUpperCase() === sym)
    .reduce((sum, p) => sum + Math.abs(Number(p?.marketValue) || 0), 0);
}

/** Find an existing option position for an OCC symbol (for sell-to-close checks). */
export function findOptionPosition(positions = [], optionSymbol) {
  const sym = String(optionSymbol ?? '').toUpperCase();
  return (
    (positions ?? []).find(
      (p) => p?.assetClass === 'us_option' && String(p?.symbol ?? '').toUpperCase() === sym
    ) ?? null
  );
}

/** Sanitized one-line-ish capability summary fields for reports (no secrets). */
export function summarizeCapabilities(cap) {
  return {
    available: cap.available,
    blocked: cap.blocked,
    equity: cap.equity,
    buyingPower: cap.buyingPower,
    multiplier: cap.multiplier,
    marginEligible: cap.marginEligible,
    shortEligible: cap.shortEligible,
    optionsEligible: cap.optionsEligible,
    optionsLevel: cap.optionsLevel,
  };
}
