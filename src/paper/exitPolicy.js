// src/paper/exitPolicy.js — When to close an open PAPER position.
//
// Pure module (no DB, no network, no clock reads): the position monitor feeds
// it entry/current prices and it answers take_profit / stop_loss / max_hold.
//
// The stop-loss and take-profit ADAPT AS THE SYSTEM LEARNS: with enough
// broker-confirmed closed outcomes, resolveLearnedExitParams() re-derives them
// from the observed win/loss distribution every cycle — inside hard rails, so
// learning can only tune the numbers, never disable the protection. This is
// the same evidence-recomputed-each-cycle philosophy as learned equity sizing
// (src/paper/equitySizing.js): nothing is written back to config files.

/** Conservative V1-inspired base parameters (fractions; 0.04 = 4%). */
export const DEFAULT_EXIT_PARAMS = Object.freeze({
  takeProfitPct: 0.04,
  stopLossPct: 0.035,
  maxHoldMinutes: 390, // one regular session — positions do not ride overnight by default
});

/** Hard rails learning can never leave (and settings are clamped into). */
export const EXIT_RAILS = Object.freeze({
  takeProfitPct: { min: 0.005, max: 0.5 },
  stopLossPct: { min: 0.005, max: 0.25 },
  maxHoldMinutes: { min: 5, max: 10080 },
});

/** How far learning may pull a parameter away from its configured base. */
const LEARNED_BASE_MULTIPLIER = Object.freeze({ min: 0.5, max: 2.5 });

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function finiteNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function posOrNull(value) {
  const n = finiteNum(value);
  return n !== null && n > 0 ? n : null;
}

/** Strategy-settings keys -> exit params, clamped into the hard rails. */
export function resolveExitSettings(settings = {}) {
  const base = {
    takeProfitPct: clamp(
      posOrNull(settings.exit_take_profit_pct) ?? DEFAULT_EXIT_PARAMS.takeProfitPct,
      EXIT_RAILS.takeProfitPct.min, EXIT_RAILS.takeProfitPct.max
    ),
    stopLossPct: clamp(
      posOrNull(settings.exit_stop_loss_pct) ?? DEFAULT_EXIT_PARAMS.stopLossPct,
      EXIT_RAILS.stopLossPct.min, EXIT_RAILS.stopLossPct.max
    ),
    maxHoldMinutes: clamp(
      posOrNull(settings.exit_max_hold_minutes) ?? DEFAULT_EXIT_PARAMS.maxHoldMinutes,
      EXIT_RAILS.maxHoldMinutes.min, EXIT_RAILS.maxHoldMinutes.max
    ),
  };
  return {
    ...base,
    learningEnabled: settings.exit_learning_enabled !== false,
    minSampleSize: Math.max(3, Number.parseInt(settings.exit_min_sample_size, 10) || 10),
  };
}

/** Signed return of an open position (short positions profit when price falls). */
export function positionReturnPct({ side, entryPrice, currentPrice }) {
  const entry = posOrNull(entryPrice);
  const current = posOrNull(currentPrice);
  if (entry === null || current === null) return null;
  const raw = (current - entry) / entry;
  return side === 'sell' ? -raw : raw;
}

/**
 * Decide whether one open position should be closed. Stop-loss is checked
 * first (protection beats profit), then take-profit, then max-hold. With no
 * usable current price only the max-hold clock can trigger (a market exit
 * needs no price to be safe to submit).
 */
export function assessExit({ side, entryPrice, currentPrice = null, entryAt, nowMs = Date.now(), params = DEFAULT_EXIT_PARAMS } = {}) {
  const returnPct = positionReturnPct({ side, entryPrice, currentPrice });
  const entryMs = Date.parse(entryAt);
  const heldMinutes = Number.isFinite(entryMs) ? Math.max(0, (nowMs - entryMs) / 60_000) : null;
  const out = (exit, reason) => ({ exit, reason, returnPct, heldMinutes });

  if (returnPct !== null && returnPct <= -params.stopLossPct) return out(true, 'stop_loss');
  if (returnPct !== null && returnPct >= params.takeProfitPct) return out(true, 'take_profit');
  if (heldMinutes !== null && heldMinutes >= params.maxHoldMinutes) return out(true, 'max_hold');
  return out(false, null);
}

/**
 * Re-derive stop/target from broker-confirmed closed outcomes (the rows
 * listBrokerConfirmedEquityOutcomes returns). Deterministic and bounded:
 * - stop-loss  -> 1.5x the average confirmed losing return (give losers a
 *   little more room than the typical loss before cutting)
 * - take-profit-> 1.25x the average confirmed winning return (let winners run
 *   a little past the typical win)
 * Both are clamped to [0.5x, 2.5x] of the configured base AND the hard rails.
 * Below minSampleSize (or learning disabled) the base parameters are used.
 */
export function resolveLearnedExitParams({
  closedOutcomes = [],
  base = DEFAULT_EXIT_PARAMS,
  learningEnabled = true,
  minSampleSize = 10,
} = {}) {
  const out = (params, mode, diagnostics, explanation) => ({ params, mode, diagnostics, explanation });

  const returns = [];
  for (const row of closedOutcomes ?? []) {
    const pnl = finiteNum(row?.broker_realized_pnl_usd);
    const price = posOrNull(row?.broker_filled_avg_price);
    const qty = posOrNull(row?.broker_filled_qty);
    if (pnl === null || price === null || qty === null) continue;
    returns.push(pnl / (price * qty));
  }
  const diagnostics = { sampleSize: returns.length, winRate: null, avgWinPct: null, avgLossPct: null };

  if (!learningEnabled) {
    return out({ ...base }, 'base', diagnostics, 'exit learning disabled; using configured base parameters');
  }
  if (returns.length < minSampleSize) {
    return out(
      { ...base },
      'base',
      diagnostics,
      `insufficient confirmed outcomes (${returns.length}/${minSampleSize}); using configured base parameters`
    );
  }

  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  diagnostics.winRate = returns.length > 0 ? wins.length / returns.length : null;
  diagnostics.avgWinPct = wins.length > 0 ? wins.reduce((s, r) => s + r, 0) / wins.length : null;
  diagnostics.avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + r, 0) / losses.length) : null;

  const learnedStop = diagnostics.avgLossPct !== null
    ? clamp(
        clamp(diagnostics.avgLossPct * 1.5, base.stopLossPct * LEARNED_BASE_MULTIPLIER.min, base.stopLossPct * LEARNED_BASE_MULTIPLIER.max),
        EXIT_RAILS.stopLossPct.min, EXIT_RAILS.stopLossPct.max
      )
    : base.stopLossPct;
  const learnedTp = diagnostics.avgWinPct !== null
    ? clamp(
        clamp(diagnostics.avgWinPct * 1.25, base.takeProfitPct * LEARNED_BASE_MULTIPLIER.min, base.takeProfitPct * LEARNED_BASE_MULTIPLIER.max),
        EXIT_RAILS.takeProfitPct.min, EXIT_RAILS.takeProfitPct.max
      )
    : base.takeProfitPct;

  const round4 = (n) => Math.round(n * 10000) / 10000;
  const params = {
    takeProfitPct: round4(learnedTp),
    stopLossPct: round4(learnedStop),
    maxHoldMinutes: base.maxHoldMinutes, // hold time is configured, not learned (yet)
  };
  return out(
    params,
    'learned',
    diagnostics,
    `learned from ${returns.length} confirmed outcome(s): stop ${(params.stopLossPct * 100).toFixed(2)}% ` +
      `tp ${(params.takeProfitPct * 100).toFixed(2)}% (win rate ${((diagnostics.winRate ?? 0) * 100).toFixed(0)}%)`
  );
}
