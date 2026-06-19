// src/paper/strategyLearning.js — Learning-based strategy-settings recommender.
//
// Reads the day's sanitized paper outcomes + the current strategy settings and
// proposes CONSERVATIVE, BOUNDED changes to the NON-SECRET strategy-settings file
// (data/strategy-settings.json) plus a next-day RESEARCH FOCUS plan.
//
// HARD RULES:
// - Writeable changes target ONLY the strategy-settings file; it NEVER edits .env
//   and NEVER touches secrets or LIVE_TRADING_ENABLED.
// - Bounded per update: notional/risk numbers +/-25%, count limits +/-20%,
//   thresholds +/-0.05; never unlimited; floors enforced.
// - Reduce risk readily after losses/repeated-rejections/drawdowns/excessive
//   orders; only suggest a SMALL bounded increase after strong positive evidence
//   over >= minSampleSize trades.
// - Research focus is a PLAN ONLY — it never drives trades and never fetches.
// - Output is sanitized: field names, numeric/flag values, our own
//   rejection-reason categories, and counts. No payloads/model text/secrets.

import { analyzeOutcomes } from './constraintRecommendations.js';
import { DEFAULT_SETTINGS } from '../config/strategySettings.js';

export const DEFAULT_MIN_SAMPLE_SIZE = 10;

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const decNum = (v) => Math.max(1, round2(v * 0.75)); // -25%, floor 1
const incNum = (v) => round2(v * 1.25); // +25%
const decCount = (v) => Math.max(1, Math.floor(v * 0.8)); // -20%, floor 1
const raiseThresh = (v) => Math.min(1, round2(v + 0.05)); // +0.05, cap 1

/**
 * Recommend bounded strategy-settings changes from the day's outcomes.
 * @returns {{ changes: object[], researchFocus: object, analysis: object }}
 */
export function buildStrategyRecommendations({ data = {}, settings = DEFAULT_SETTINGS, minSampleSize = DEFAULT_MIN_SAMPLE_SIZE } = {}) {
  const a = analyzeOutcomes(data);
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const changes = [];
  const seen = new Set();
  const push = (field, action, recommendedValue, reason, confidence, urgency) => {
    if (seen.has(field) || s[field] === undefined) return; // one change per field
    seen.add(field);
    changes.push({
      field, action, currentValue: s[field], recommendedValue, reason, confidence, urgency,
      writeable: true, envOnly: false,
      evidence: {
        winningTrades: a.winningTrades, losingTrades: a.losingTrades,
        ordersSubmitted: a.ordersSubmitted, rejectedCount: a.rejectedCount,
      },
    });
  };

  if (a.losingDay) {
    push('max_order_notional', 'decrease', decNum(s.max_order_notional),
      `Losing day (realized ${a.realizedPnl}); cut per-order notional until win rate improves.`,
      a.losingTrades >= 3 ? 'high' : 'medium', a.losingTrades >= 3 ? 'important' : 'recommended');
    push('confidence_threshold', 'increase', raiseThresh(s.confidence_threshold),
      'Losing day; tighten entries by raising the confidence threshold.', 'medium', 'recommended');
    push('max_daily_paper_notional', 'decrease', decNum(s.max_daily_paper_notional),
      'Losing day; reduce the daily notional budget.', 'medium', 'recommended');
  }
  if (a.categories.notional >= 3) {
    push('max_order_notional', 'decrease', decNum(s.max_order_notional),
      `${a.categories.notional} notional refusal(s); reduce per-order notional.`, 'medium', 'recommended');
  }
  if (a.categories.exposure >= 3) {
    push('max_gross_exposure', 'decrease', decNum(s.max_gross_exposure),
      `${a.categories.exposure} exposure refusal(s); reduce the gross exposure cap.`, 'medium', 'recommended');
  }
  if (a.ordersSubmitted > s.max_daily_paper_orders) {
    push('max_daily_paper_orders', 'decrease', decCount(s.max_daily_paper_orders),
      `${a.ordersSubmitted} orders exceeds the daily cap; slow trade frequency.`, 'medium', 'recommended');
  }
  if (a.categories.options >= 2) {
    if (s.options_mode !== 'plan_only') {
      push('options_mode', 'set', 'plan_only',
        `${a.categories.options} option refusal(s); keep options plan_only until they prove out.`, 'medium', 'recommended');
    } else {
      push('max_option_premium', 'decrease', decNum(s.max_option_premium),
        `${a.categories.options} option refusal(s); lower the option premium cap.`, 'medium', 'recommended');
    }
  }
  if (a.categories.shorts >= 2) {
    push('sentiment_threshold', 'increase', raiseThresh(s.sentiment_threshold),
      `${a.categories.shorts} short/margin refusal(s); raise the sentiment threshold (or disable shorts).`, 'medium', 'recommended');
  }

  const strongPositive =
    a.sampleSize >= minSampleSize && a.realizedPnl > 0 &&
    a.winningTrades >= a.losingTrades * 2 &&
    a.rejectedCount <= Math.max(2, Math.floor(a.ordersSubmitted * 0.25));
  if (strongPositive) {
    push('max_order_notional', 'increase', incNum(s.max_order_notional),
      `Strong positive evidence (${a.winningTrades}W/${a.losingTrades}L, +${a.realizedPnl} over ${a.sampleSize}); small bounded notional increase.`,
      'medium', 'monitor');
  }

  return { changes: changes.slice(0, 8), researchFocus: buildResearchFocus({ data, settings: s, analysis: a }), analysis: a };
}

/** Build a sanitized next-day research-focus PLAN (never drives trades/fetches). */
export function buildResearchFocus({ data = {}, settings = DEFAULT_SETTINGS, analysis } = {}) {
  const a = analysis ?? analyzeOutcomes(data);
  const symbols = new Set((settings.scrape_symbol_focus ?? []).map((x) => String(x).toUpperCase()));
  if (data.worstTicker) symbols.add(String(data.worstTicker).toUpperCase());
  const topics = new Set();
  const prioritize = new Set(settings.scrape_target_groups ?? []);
  const avoid = new Set();
  const reasons = [];

  if (a.categories.options >= 1) {
    topics.add('options_chain'); topics.add('catalysts'); prioritize.add('options_research');
    reasons.push('Repeated option refusals/losses; prioritize options-chain and catalyst research.');
  }
  if (a.categories.shorts >= 1) {
    topics.add('short_interest'); topics.add('borrow_availability');
    reasons.push('Short refusals; research short interest / borrow availability before re-enabling shorts.');
  }
  if (a.categories.notional >= 1 || a.categories.exposure >= 1) {
    topics.add('liquidity');
    reasons.push('Notional/exposure refusals; research liquidity and right-size orders.');
  }
  if (a.losingDay) {
    topics.add('news_catalysts');
    reasons.push('Losing day; focus on higher-conviction catalysts rather than more volume.');
  }
  if (reasons.length === 0) reasons.push('No strong signal; maintain the current research focus.');

  return {
    symbolsToResearch: [...symbols],
    topicsToResearch: [...topics],
    prioritizeGroups: [...prioritize],
    avoidGroups: [...avoid],
    reasons,
  };
}

/** Apply writeable changes to a settings object (pure; returns a new object). */
export function applyStrategyChanges(settings, changes = []) {
  const next = { ...settings };
  for (const c of changes) if (c.writeable && c.field in next) next[c.field] = c.recommendedValue;
  return next;
}

/** Turn applied changes into note entries (for appendNotes; deduped+capped there). */
export function changesToNotes(changes = [], { now = () => new Date().toISOString() } = {}) {
  const at = now();
  return (changes ?? [])
    .filter((c) => c.writeable)
    .map((c) => ({ at, kind: 'learning_update', field: c.field, from: c.currentValue, to: c.recommendedValue, reason: c.reason, confidence: c.confidence }));
}

/** Sanitized strategy-recommendations section for the EOD report. */
export function formatStrategySection(result) {
  const lines = ['— Strategy setting recommendations (data/strategy-settings.json) —'];
  const changes = result?.changes ?? [];
  if (changes.length === 0) {
    lines.push('  No strategy setting changes recommended today.');
  } else {
    for (const c of changes) {
      lines.push(
        `  • ${c.field}: ${c.action}  (${c.currentValue} -> ${c.recommendedValue})  [${c.urgency}, confidence ${c.confidence}]`,
        `      reason: ${c.reason}`
      );
    }
    lines.push('  Apply with: scripts/updateStrategySettingsFromLearning.js --write (.env is never edited).');
  }
  const rf = result?.researchFocus;
  if (rf) {
    lines.push(
      '— Next-day research focus (plan only) —',
      `  symbols: ${rf.symbolsToResearch.join(', ') || '(none)'}`,
      `  topics:  ${rf.topicsToResearch.join(', ') || '(none)'}`,
      `  prioritize groups: ${rf.prioritizeGroups.join(', ') || '(none)'}`
    );
    for (const r of rf.reasons.slice(0, 4)) lines.push(`  reason: ${r}`);
  }
  return lines;
}
