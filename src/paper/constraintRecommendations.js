// src/paper/constraintRecommendations.js — Conservative, BOUNDED recommendations
// for MANUAL .env constraint edits, derived from the day's paper outcomes.
//
// HARD RULES (load-bearing):
// - This module NEVER edits .env / .env.example / any file. It only RETURNS
//   recommendations; a human applies them by hand.
// - It NEVER recommends enabling live trading. LIVE_TRADING_ENABLED is only ever
//   recommended to stay/become false; any "=true" suggestion is filtered out.
// - Changes are conservative and bounded per update: percentages +/- 25% max,
//   count limits +/- 20% max, thresholds +/- 0.05 max; never unlimited; never
//   above the variable's configured ceiling. Decreasing risk needs only modest
//   evidence; INCREASING a limit needs strong positive evidence + enough samples.
// - Output is sanitized: variable names, numeric/flag values, our own
//   rejection-reason strings, and counts only. No secrets, payloads, or model text.

/** Minimum trades before a risk-INCREASE may even be considered. */
export const DEFAULT_MIN_SAMPLE_SIZE = 10;

/** Repeated-rejection thresholds that trigger a conservative tightening. */
const REPEAT_REJECTIONS = 3;
const REPEAT_CATEGORY = 2; // shorts/options are gated sooner

/** Recommendable env knobs + conservative bounds. kind drives the math. */
export const VARIABLE_SPECS = Object.freeze({
  MAX_TRADE_NOTIONAL_PCT: { kind: 'pct', start: 0.01, floor: 0.001, ceil: 0.05 },
  MAX_POSITION_PCT: { kind: 'pct', start: 0.05, floor: 0.005, ceil: 0.25 },
  MAX_TOTAL_EXPOSURE_PCT: { kind: 'pct', start: 0.2, floor: 0.02, ceil: 1.0 },
  MAX_DAILY_LOSS_PCT: { kind: 'pct', start: 0.02, floor: 0.005, ceil: 0.1 },
  MAX_TRADES_PER_DAY: { kind: 'count', start: 10, floor: 1, ceil: 50 },
  MAX_OPEN_POSITIONS: { kind: 'count', start: 5, floor: 1, ceil: 25 },
  PAPER_CONFIDENCE_THRESHOLD: { kind: 'threshold', start: 0.6, floor: 0.0, ceil: 1.0 },
  PAPER_IMPACT_THRESHOLD: { kind: 'threshold', start: 0.5, floor: 0.0, ceil: 1.0 },
  PAPER_SENTIMENT_THRESHOLD: { kind: 'threshold', start: 0.3, floor: 0.0, ceil: 1.0 },
  PAPER_ENABLE_SHORTS: { kind: 'flag' },
  PAPER_ENABLE_OPTIONS: { kind: 'flag' },
  PAPER_ENABLE_MARGIN: { kind: 'flag' },
});

function roundTo(n, d) {
  const f = 10 ** d;
  return Math.round(Number(n) * f) / f;
}
function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Bounded recommended numeric value for a (variable, direction). */
function boundedValue(variable, direction, current) {
  const spec = VARIABLE_SPECS[variable];
  const cur = asNum(current);
  if (spec.kind === 'pct') {
    if (cur === null) return spec.start; // introduce a cap at a conservative value
    return direction === 'down'
      ? Math.max(spec.floor, roundTo(cur * 0.75, 4)) // -25%
      : Math.min(spec.ceil, roundTo(cur * 1.25, 4)); // +25%
  }
  if (spec.kind === 'count') {
    if (cur === null) return spec.start;
    return direction === 'down'
      ? Math.max(spec.floor, Math.floor(cur * 0.8)) // -20%
      : Math.min(spec.ceil, Math.ceil(cur * 1.2)); // +20%
  }
  if (spec.kind === 'threshold') {
    const base = cur === null ? spec.start : cur;
    return direction === 'up'
      ? Math.min(spec.ceil, roundTo(base + 0.05, 2)) // tighten
      : Math.max(spec.floor, roundTo(base - 0.05, 2)); // loosen
  }
  return null;
}

/** Analyze the day's sanitized aggregates into outcome signals. */
export function analyzeOutcomes(data = {}) {
  const trades = Array.isArray(data.trades) ? data.trades : [];
  const winningTrades = asNum(data.winningTrades) ?? trades.filter((t) => Number(t.pnl) > 0).length;
  const losingTrades = asNum(data.losingTrades) ?? trades.filter((t) => Number(t.pnl) < 0).length;
  const realizedPnl = asNum(data.realizedPnl) ?? 0;
  const ordersSubmitted = asNum(data.ordersSubmitted) ?? 0;
  const rejectedCount = asNum(data.rejectedCount) ?? 0;
  const reasons = Array.isArray(data.rejectionReasons) ? data.rejectionReasons : [];

  const sumWhere = (re) => reasons.filter((r) => re.test(r.reason)).reduce((s, r) => s + Number(r.n || 0), 0);
  const categories = {
    notional: sumWhere(/notional/i),
    exposure: sumWhere(/exposure/i),
    buyingPower: sumWhere(/buying power/i),
    shorts: sumWhere(/short|margin/i),
    options: sumWhere(/option/i),
  };

  return {
    winningTrades, losingTrades, realizedPnl, ordersSubmitted, rejectedCount,
    sampleSize: winningTrades + losingTrades, categories,
    losingDay: realizedPnl < 0,
  };
}

/**
 * Produce conservative, bounded constraint-change recommendations.
 *
 * @param {object} args
 * @param {object} args.data     EOD aggregates (collectEodData shape)
 * @param {object} [args.current] map of variable -> current value (null/absent = not set)
 * @param {number} [args.minSampleSize]
 * @returns {{ recommendations: object[], analysis: object }}
 */
export function buildConstraintRecommendations({ data = {}, current = {}, minSampleSize = DEFAULT_MIN_SAMPLE_SIZE } = {}) {
  const a = analyzeOutcomes(data);
  const cur = current ?? {};
  const out = [];
  const seen = new Set();

  const currentLabel = (v) => (cur[v] === undefined || cur[v] === null ? '(not set)' : cur[v]);
  const push = (variable, action, recommendedValue, reason, confidence, urgency, evidence) => {
    if (seen.has(variable)) return; // one rec per variable; first (highest priority) wins
    // Absolute guard: never emit an enable-live recommendation.
    if (variable === 'LIVE_TRADING_ENABLED' && String(recommendedValue) === 'true') return;
    seen.add(variable);
    out.push({
      variable,
      action,
      currentValue: currentLabel(variable),
      recommendedValue,
      reason,
      confidence,
      urgency,
      evidence: {
        winningTrades: a.winningTrades, losingTrades: a.losingTrades,
        ordersSubmitted: a.ordersSubmitted, rejectedCount: a.rejectedCount,
        ...evidence,
      },
      manualEditLine: `${variable}=${recommendedValue}`,
      envOnly: true,
    });
  };

  // --- Risk-DECREASE rules (modest evidence is enough) ----------------------

  // Always keep live trading off if it is (somehow) enabled.
  if (String(cur.LIVE_TRADING_ENABLED) === 'true') {
    push('LIVE_TRADING_ENABLED', 'keep_false', 'false',
      'Live trading must remain disabled; this system is paper-only.', 'high', 'important', {});
  }

  if (a.losingDay) {
    push('MAX_TRADE_NOTIONAL_PCT', cur.MAX_TRADE_NOTIONAL_PCT == null ? 'set' : 'decrease',
      boundedValue('MAX_TRADE_NOTIONAL_PCT', 'down', cur.MAX_TRADE_NOTIONAL_PCT),
      `Net realized P&L was negative (${a.realizedPnl}) with ${a.losingTrades} losing vs ${a.winningTrades} winning trade(s); reduce per-trade notional until win rate improves.`,
      a.losingTrades >= 3 ? 'high' : 'medium', a.losingTrades >= 3 ? 'important' : 'recommended', { realizedPnl: a.realizedPnl });
    push('PAPER_CONFIDENCE_THRESHOLD', 'increase',
      boundedValue('PAPER_CONFIDENCE_THRESHOLD', 'up', cur.PAPER_CONFIDENCE_THRESHOLD),
      'Losing day: tighten entries by raising the minimum confidence threshold.',
      'medium', 'recommended', { realizedPnl: a.realizedPnl });
    push('MAX_DAILY_LOSS_PCT', cur.MAX_DAILY_LOSS_PCT == null ? 'set' : 'decrease',
      boundedValue('MAX_DAILY_LOSS_PCT', 'down', cur.MAX_DAILY_LOSS_PCT),
      'Losing day: tighten the daily loss cap to limit downside while the edge is unproven.',
      'medium', 'recommended', { realizedPnl: a.realizedPnl });
  }

  if (a.categories.notional >= REPEAT_REJECTIONS) {
    push('MAX_TRADE_NOTIONAL_PCT', cur.MAX_TRADE_NOTIONAL_PCT == null ? 'set' : 'decrease',
      boundedValue('MAX_TRADE_NOTIONAL_PCT', 'down', cur.MAX_TRADE_NOTIONAL_PCT),
      `${a.categories.notional} order(s) were refused for notional caps; reduce the proposed per-trade notional (or review the cap manually).`,
      'medium', 'recommended', { notionalRejections: a.categories.notional });
  }
  if (a.categories.exposure >= REPEAT_REJECTIONS) {
    push('MAX_TOTAL_EXPOSURE_PCT', cur.MAX_TOTAL_EXPOSURE_PCT == null ? 'set' : 'decrease',
      boundedValue('MAX_TOTAL_EXPOSURE_PCT', 'down', cur.MAX_TOTAL_EXPOSURE_PCT),
      `${a.categories.exposure} order(s) were refused for exposure caps; reduce total exposure (or review the cap manually).`,
      'medium', 'recommended', { exposureRejections: a.categories.exposure });
  }
  if (a.ordersSubmitted > (asNum(cur.MAX_TRADES_PER_DAY) ?? VARIABLE_SPECS.MAX_TRADES_PER_DAY.start)) {
    push('MAX_TRADES_PER_DAY', cur.MAX_TRADES_PER_DAY == null ? 'set' : 'decrease',
      boundedValue('MAX_TRADES_PER_DAY', 'down', cur.MAX_TRADES_PER_DAY),
      `${a.ordersSubmitted} orders in one day exceeds the daily cap; slow trade frequency.`,
      'medium', 'recommended', {});
  }
  if (a.categories.options >= REPEAT_CATEGORY) {
    push('PAPER_ENABLE_OPTIONS', 'keep_false', 'false',
      `${a.categories.options} option proposal(s) were refused; keep PAPER_ENABLE_OPTIONS=false until options exits and outcomes prove out.`,
      'medium', 'recommended', { optionRejections: a.categories.options });
  }
  if (a.categories.shorts >= REPEAT_CATEGORY) {
    push('PAPER_SENTIMENT_THRESHOLD', 'increase',
      boundedValue('PAPER_SENTIMENT_THRESHOLD', 'up', cur.PAPER_SENTIMENT_THRESHOLD),
      `${a.categories.shorts} short/margin refusal(s); raise the sentiment threshold (or keep PAPER_ENABLE_SHORTS=false) until shorts prove out.`,
      'medium', 'recommended', { shortRejections: a.categories.shorts });
  }

  // --- Risk-INCREASE rule (strong positive evidence + enough samples only) ---
  const strongPositive =
    a.sampleSize >= minSampleSize &&
    a.realizedPnl > 0 &&
    a.winningTrades >= a.losingTrades * 2 &&
    a.rejectedCount <= Math.max(2, Math.floor(a.ordersSubmitted * 0.25));
  if (strongPositive && cur.MAX_TRADE_NOTIONAL_PCT != null) {
    push('MAX_TRADE_NOTIONAL_PCT', 'increase',
      boundedValue('MAX_TRADE_NOTIONAL_PCT', 'up', cur.MAX_TRADE_NOTIONAL_PCT),
      `Strong positive evidence (${a.winningTrades} wins vs ${a.losingTrades} losses, +${a.realizedPnl} over ${a.sampleSize} trades); a SMALL bounded notional increase may be warranted — review manually.`,
      'medium', 'monitor', { realizedPnl: a.realizedPnl, sampleSize: a.sampleSize });
  }

  return { recommendations: out.slice(0, 6), analysis: a };
}

/** Caution line appended whenever recommendations are shown. */
export const NO_AUTO_EDIT_CAUTION = 'The bot did not edit .env. These are recommendations only.';

/**
 * Render the "Recommended manual .env changes" section as sanitized lines.
 * Always includes the header; shows the no-change message when empty.
 */
export function formatRecommendationsSection(recommendations = []) {
  const lines = ['— Recommended manual .env changes —'];
  if (!recommendations || recommendations.length === 0) {
    lines.push('  No manual .env constraint changes recommended today.');
    return lines;
  }
  for (const r of recommendations) {
    lines.push(
      `  • ${r.variable}: ${r.action}  (current ${r.currentValue} -> ${r.recommendedValue})` +
        `  [${r.urgency}, confidence ${r.confidence}]`,
      `      reason: ${r.reason}`,
      `      evidence: wins=${r.evidence.winningTrades} losses=${r.evidence.losingTrades} ` +
        `orders=${r.evidence.ordersSubmitted} rejections=${r.evidence.rejectedCount}`,
      `      edit:   ${r.manualEditLine}`
    );
  }
  lines.push(`  ${NO_AUTO_EDIT_CAUTION}`);
  return lines;
}
