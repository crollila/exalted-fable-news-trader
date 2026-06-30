// src/paper/equitySizing.js - Pure learned target sizing for PAPER equities.
//
// This module never fetches data, never submits orders, never writes storage,
// and never uses broker-wide account returns as learning evidence. Callers pass
// broker-confirmed, ExaltedFable-owned equity outcomes and current owned
// exposure context.

export const SIZING_MODES = Object.freeze({
  COLD_START: 'cold_start',
  EVIDENCE_WEIGHTED: 'evidence_weighted',
  ABSTAIN: 'abstain',
});

export const EVIDENCE_TIERS = Object.freeze({
  EXACT: 'exact_signal',
  NEWS_DIRECTION_SCORE: 'news_type_direction_score',
  DIRECTION_SCORE: 'direction_score',
  NONE: 'none',
});

export const DEFAULT_EQUITY_SIZING_SETTINGS = Object.freeze({
  sizing_min_comparable_sample_size: 10,
  sizing_cold_start_target_weight: 0.0075,
  sizing_max_target_weight: 0.01,
  sizing_enable_confidence_scaling: true,
  sizing_enable_impact_scaling: true,
});

const VALID_MODES = new Set(Object.values(SIZING_MODES));

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function posNum(value) {
  const n = numOrNull(value);
  return n !== null && n > 0 ? n : null;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function round(value, digits = 6) {
  const n = numOrNull(value);
  if (n === null) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function cleanText(value) {
  const s = String(value ?? '').trim();
  return s || null;
}

function upper(value) {
  const s = cleanText(value);
  return s ? s.toUpperCase() : null;
}

function scoreBand(value) {
  const n = numOrNull(value);
  if (n === null) return 'na';
  if (n >= 0.8) return 'very_high';
  if (n >= 0.65) return 'high';
  if (n >= 0.5) return 'medium';
  if (n >= 0.35) return 'low';
  return 'very_low';
}

export function scoreBucket(signal = {}) {
  return [
    `c:${scoreBand(signal.confidence)}`,
    `i:${scoreBand(signal.impact)}`,
    `s:${scoreBand(Math.abs(numOrNull(signal.sentiment) ?? 0))}`,
  ].join('|');
}

function normalizeSignal(signal = {}) {
  return {
    ticker: upper(signal.ticker),
    side: cleanText(signal.side),
    direction: cleanText(signal.direction),
    confidence: numOrNull(signal.confidence),
    impact: numOrNull(signal.impact),
    sentiment: numOrNull(signal.sentiment),
    newsType: cleanText(signal.newsType ?? signal.news_type),
    model: cleanText(signal.model),
    promptVersion: cleanText(signal.promptVersion ?? signal.prompt_version),
  };
}

function normalizedSettings(settings = {}) {
  const merged = { ...DEFAULT_EQUITY_SIZING_SETTINGS, ...(settings ?? {}) };
  const minSample = Number.parseInt(merged.sizing_min_comparable_sample_size, 10);
  return {
    sizing_min_comparable_sample_size: Number.isInteger(minSample) && minSample > 0 ? minSample : DEFAULT_EQUITY_SIZING_SETTINGS.sizing_min_comparable_sample_size,
    sizing_cold_start_target_weight: clamp(posNum(merged.sizing_cold_start_target_weight) ?? DEFAULT_EQUITY_SIZING_SETTINGS.sizing_cold_start_target_weight, 0.0001, 0.01),
    sizing_max_target_weight: clamp(posNum(merged.sizing_max_target_weight) ?? DEFAULT_EQUITY_SIZING_SETTINGS.sizing_max_target_weight, 0.0001, 0.01),
    sizing_enable_confidence_scaling: merged.sizing_enable_confidence_scaling !== false,
    sizing_enable_impact_scaling: merged.sizing_enable_impact_scaling !== false,
  };
}

export function resolveEquitySizingSettings(settings = {}) {
  return normalizedSettings(settings);
}

function baseDecision(overrides = {}) {
  const mode = VALID_MODES.has(overrides.mode) ? overrides.mode : SIZING_MODES.ABSTAIN;
  return {
    mode,
    requestedTargetWeight: null,
    requestedNotional: null,
    requestedQuantity: 0,
    evidenceCount: 0,
    evidenceQuality: 'none',
    evidenceTier: EVIDENCE_TIERS.NONE,
    reason: 'unavailable',
    warnings: [],
    diagnostics: {},
    ...overrides,
    mode,
  };
}

function comparableKeys(signal) {
  const bucket = scoreBucket(signal);
  const common = [signal.direction, bucket, signal.model, signal.promptVersion].map((x) => x ?? 'na');
  return [
    {
      tier: EVIDENCE_TIERS.EXACT,
      key: [signal.ticker ?? 'na', signal.newsType ?? 'na', ...common].join('|'),
      match: (o) => o.ticker === signal.ticker && o.newsType === signal.newsType && o.direction === signal.direction && o.bucket === bucket,
    },
    {
      tier: EVIDENCE_TIERS.NEWS_DIRECTION_SCORE,
      key: [signal.newsType ?? 'na', ...common].join('|'),
      match: (o) => o.newsType === signal.newsType && o.direction === signal.direction && o.bucket === bucket,
    },
    {
      tier: EVIDENCE_TIERS.DIRECTION_SCORE,
      key: common.join('|'),
      match: (o) => o.direction === signal.direction && o.bucket === bucket,
    },
  ];
}

function normalizeOutcome(row = {}) {
  const filledQty = posNum(row.brokerFilledQty ?? row.broker_filled_qty ?? row.filledQty);
  const fillPrice = posNum(row.brokerFilledAvgPrice ?? row.broker_filled_avg_price ?? row.filledAvgPrice);
  const pnl = numOrNull(row.brokerRealizedPnlUsd ?? row.broker_realized_pnl_usd ?? row.realizedPnlUsd);
  const eventId = Number.parseInt(row.newsEventId ?? row.news_event_id, 10);
  const signal = normalizeSignal({
    ticker: row.ticker,
    side: row.side,
    direction: row.direction,
    confidence: row.confidence,
    impact: row.impact ?? row.impact_score,
    sentiment: row.sentiment ?? row.sentiment_score,
    newsType: row.newsType ?? row.news_type,
    model: row.model,
    promptVersion: row.promptVersion ?? row.prompt_version,
  });
  const notional = filledQty !== null && fillPrice !== null ? Math.abs(filledQty * fillPrice) : null;
  if (!Number.isInteger(eventId) || eventId <= 0 || filledQty === null || fillPrice === null || pnl === null || notional === null || notional <= 0) {
    return null;
  }
  if (!signal.model || !signal.promptVersion || !signal.direction) return null;
  return {
    newsEventId: eventId,
    ticker: signal.ticker,
    side: cleanText(row.side),
    direction: signal.direction,
    confidence: signal.confidence,
    impact: signal.impact,
    sentiment: signal.sentiment,
    newsType: signal.newsType,
    model: signal.model,
    promptVersion: signal.promptVersion,
    bucket: scoreBucket(signal),
    notional,
    realizedPnlUsd: pnl,
    returnPct: pnl / notional,
  };
}

function independentOutcomes(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows ?? []) {
    const normalized = normalizeOutcome(row);
    if (!normalized) continue;
    if (seen.has(normalized.newsEventId)) continue;
    seen.add(normalized.newsEventId);
    out.push(normalized);
  }
  return out;
}

function summarizeEvidence(rows = []) {
  if (rows.length === 0) {
    return { count: 0, avgPnl: null, avgReturnPct: null, winRate: null, wins: 0, losses: 0 };
  }
  let pnl = 0;
  let ret = 0;
  let wins = 0;
  let losses = 0;
  for (const row of rows) {
    pnl += row.realizedPnlUsd;
    ret += row.returnPct;
    if (row.realizedPnlUsd > 0) wins += 1;
    if (row.realizedPnlUsd < 0) losses += 1;
  }
  return {
    count: rows.length,
    avgPnl: pnl / rows.length,
    avgReturnPct: ret / rows.length,
    winRate: wins / rows.length,
    wins,
    losses,
  };
}

export function selectComparableEvidence({ signal, historicalOutcomes = [], minSampleSize = DEFAULT_EQUITY_SIZING_SETTINGS.sizing_min_comparable_sample_size } = {}) {
  const s = normalizeSignal(signal);
  const minN = Math.max(1, Number.parseInt(minSampleSize, 10) || DEFAULT_EQUITY_SIZING_SETTINGS.sizing_min_comparable_sample_size);
  const clean = independentOutcomes(historicalOutcomes).filter((o) =>
    o.model === s.model &&
    o.promptVersion === s.promptVersion &&
    o.direction === s.direction
  );
  let bestSparse = { tier: EVIDENCE_TIERS.NONE, rows: [], summary: summarizeEvidence([]) };
  for (const tier of comparableKeys(s)) {
    const rows = clean.filter(tier.match);
    const summary = summarizeEvidence(rows);
    if (summary.count > bestSparse.summary.count) bestSparse = { tier: tier.tier, rows, summary };
    if (summary.count >= minN) {
      return { tier: tier.tier, rows, summary, sufficient: true, bestSparse };
    }
  }
  return { tier: bestSparse.tier, rows: bestSparse.rows, summary: bestSparse.summary, sufficient: false, bestSparse };
}

function scoreScale(signal, settings) {
  let scale = 1;
  if (settings.sizing_enable_confidence_scaling) {
    const c = clamp(numOrNull(signal.confidence) ?? 0, 0, 1);
    scale *= 0.5 + 0.5 * c;
  }
  if (settings.sizing_enable_impact_scaling) {
    const i = clamp(numOrNull(signal.impact) ?? 0, 0, 1);
    scale *= 0.5 + 0.5 * i;
  }
  return clamp(scale, 0.25, 1);
}

function targetWeightFromEvidence({ signal, settings, evidence }) {
  const summary = evidence.summary;
  if (summary.count <= 0) return null;
  if ((summary.avgPnl ?? 0) <= 0 || (summary.avgReturnPct ?? 0) <= 0 || (summary.winRate ?? 0) <= 0.5) {
    return null;
  }
  const shrink = summary.count / (summary.count + settings.sizing_min_comparable_sample_size * 2);
  const returnBoost = Math.min(0.4, Math.max(0, summary.avgReturnPct) * 5 * shrink);
  const winBoost = Math.min(0.2, Math.max(0, summary.winRate - 0.5) * shrink);
  return settings.sizing_cold_start_target_weight * (1 + returnBoost + winBoost) * scoreScale(signal, settings);
}

function sizeFromWeight({ mode, targetWeight, referencePrice, account, currentExposure, reason, evidence }) {
  const ref = posNum(referencePrice);
  if (ref === null) {
    return baseDecision({
      mode: SIZING_MODES.ABSTAIN,
      reason: 'abstain: valid reference price unavailable for learned equity sizing',
      evidenceCount: evidence?.summary?.count ?? 0,
      evidenceQuality: evidence?.sufficient ? 'sufficient' : evidence?.summary?.count > 0 ? 'limited' : 'none',
      evidenceTier: evidence?.tier ?? EVIDENCE_TIERS.NONE,
    });
  }
  const equity = posNum(account?.equity ?? account?.portfolioValue);
  if (equity === null) {
    return baseDecision({
      mode: SIZING_MODES.ABSTAIN,
      reason: 'abstain: broker account equity unavailable for portfolio target sizing',
      evidenceCount: evidence?.summary?.count ?? 0,
      evidenceQuality: evidence?.sufficient ? 'sufficient' : evidence?.summary?.count > 0 ? 'limited' : 'none',
      evidenceTier: evidence?.tier ?? EVIDENCE_TIERS.NONE,
    });
  }
  const weight = clamp(targetWeight, 0, 1);
  const targetNotional = equity * weight;
  const notional = targetNotional - (posNum(currentExposure) ?? 0);
  if (!Number.isFinite(notional) || notional <= 0) {
    return baseDecision({
      mode: SIZING_MODES.ABSTAIN,
      reason: 'abstain: target allocation already filled or no notional budget remains',
      evidenceCount: evidence?.summary?.count ?? 0,
      evidenceQuality: evidence?.sufficient ? 'sufficient' : evidence?.summary?.count > 0 ? 'limited' : 'none',
      evidenceTier: evidence?.tier ?? EVIDENCE_TIERS.NONE,
      requestedTargetWeight: round(weight),
      requestedNotional: 0,
    });
  }
  const qty = Math.floor(notional / ref);
  if (qty <= 0) {
    return baseDecision({
      mode: SIZING_MODES.ABSTAIN,
      reason: 'abstain: target notional is below one whole share at the reference price',
      evidenceCount: evidence?.summary?.count ?? 0,
      evidenceQuality: evidence?.sufficient ? 'sufficient' : evidence?.summary?.count > 0 ? 'limited' : 'none',
      evidenceTier: evidence?.tier ?? EVIDENCE_TIERS.NONE,
      requestedTargetWeight: round(weight),
      requestedNotional: round(notional, 2),
    });
  }
  return baseDecision({
    mode,
    requestedTargetWeight: round(weight),
    requestedNotional: round(qty * ref, 2),
    requestedQuantity: qty,
    evidenceCount: evidence?.summary?.count ?? 0,
    evidenceQuality: evidence?.sufficient ? 'sufficient' : evidence?.summary?.count > 0 ? 'limited' : 'none',
    evidenceTier: evidence?.tier ?? EVIDENCE_TIERS.NONE,
    reason,
    diagnostics: {
      targetNotional: round(targetNotional, 2),
      currentExposure: round(posNum(currentExposure) ?? 0, 2),
      referencePrice: round(ref, 4),
      accountEquity: round(equity, 2),
      evidenceSummary: evidence?.summary ?? summarizeEvidence([]),
    },
  });
}

export function decideEquitySizing({
  signal = {},
  referencePrice = null,
  account = null,
  caps = {},
  daily = {},
  settings = {},
  currentOwnedExposure = 0,
  historicalOutcomes = [],
  duplicateAttempt = false,
  dataQualityWarnings = [],
} = {}) {
  const s = normalizeSignal(signal);
  const cfg = normalizedSettings(settings);
  const warnings = [...(dataQualityWarnings ?? []).map((w) => String(w)).filter(Boolean)];

  if (duplicateAttempt) {
    return baseDecision({
      mode: SIZING_MODES.ABSTAIN,
      evidenceQuality: 'limited',
      reason: 'abstain: duplicate/stale event attempt is not eligible for learned sizing',
      warnings: ['duplicate/stale event attempt excluded from sizing evidence', ...warnings],
    });
  }
  if (!s.ticker || !s.direction || !s.model || !s.promptVersion) {
    return baseDecision({
      mode: SIZING_MODES.ABSTAIN,
      evidenceQuality: 'limited',
      reason: 'abstain: sanitized signal metadata is incomplete',
      warnings,
    });
  }

  const evidence = selectComparableEvidence({
    signal: s,
    historicalOutcomes,
    minSampleSize: cfg.sizing_min_comparable_sample_size,
  });
  if (evidence.sufficient) {
    const target = targetWeightFromEvidence({ signal: s, settings: cfg, evidence });
    if (target === null) {
      return baseDecision({
        mode: SIZING_MODES.ABSTAIN,
        evidenceCount: evidence.summary.count,
        evidenceQuality: 'sufficient',
        evidenceTier: evidence.tier,
        reason: `abstain: comparable ${evidence.tier} outcomes are losing or uncertain`,
        warnings,
        diagnostics: { evidenceSummary: evidence.summary },
      });
    }
    return {
      ...sizeFromWeight({
        mode: SIZING_MODES.EVIDENCE_WEIGHTED,
        signal: s,
        targetWeight: Math.min(target, cfg.sizing_max_target_weight),
        referencePrice,
        account,
        currentExposure: currentOwnedExposure,
        caps,
        daily,
        reason: `evidence-weighted sizing from ${evidence.summary.count} broker-confirmed ${evidence.tier} outcome(s)`,
        evidence,
      }),
      warnings,
    };
  }

  if (evidence.summary.count > 0 && ((evidence.summary.avgPnl ?? 0) <= 0 || (evidence.summary.winRate ?? 0) <= 0.5)) {
    return baseDecision({
      mode: SIZING_MODES.ABSTAIN,
      evidenceCount: evidence.summary.count,
      evidenceQuality: 'limited',
      evidenceTier: evidence.tier,
      reason: `abstain: sparse comparable ${evidence.tier} outcomes are losing or uncertain`,
      warnings,
      diagnostics: { evidenceSummary: evidence.summary },
    });
  }

  const coldWeight = Math.min(
    cfg.sizing_cold_start_target_weight * scoreScale(s, cfg),
    cfg.sizing_max_target_weight
  );
  return {
    ...sizeFromWeight({
      mode: SIZING_MODES.COLD_START,
      signal: s,
      targetWeight: coldWeight,
      referencePrice,
      account,
      currentExposure: currentOwnedExposure,
      caps,
      daily,
      reason: evidence.summary.count > 0
        ? `cold-start sizing: only ${evidence.summary.count} comparable broker-confirmed outcome(s), below ${cfg.sizing_min_comparable_sample_size}`
        : 'cold-start sizing: no comparable broker-confirmed outcomes yet',
      evidence,
    }),
    warnings,
  };
}

export function formatSizingDecision(decision = {}) {
  if (!decision) return 'sizing unavailable';
  const qty = Number.isInteger(decision.requestedQuantity) ? decision.requestedQuantity : 0;
  const notional = decision.requestedNotional === null || decision.requestedNotional === undefined
    ? 'unavailable'
    : `$${Number(decision.requestedNotional).toFixed(2)}`;
  const weight = decision.requestedTargetWeight === null || decision.requestedTargetWeight === undefined
    ? 'unavailable'
    : `${(Number(decision.requestedTargetWeight) * 100).toFixed(2)}%`;
  return `${decision.mode ?? 'unknown'} qty=${qty} notional=${notional} target=${weight} evidence=${decision.evidenceCount ?? 0} (${decision.reason ?? 'no reason'})`;
}
