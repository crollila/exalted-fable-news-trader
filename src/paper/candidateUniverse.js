// src/paper/candidateUniverse.js - Controlled candidate universe ranking.
//
// Uses only configured/base symbols and data already stored by supported
// providers/model runs. No scraping, browser automation, or new network calls.

import { insertUniverseSelections } from '../database/paperRuntime.js';

export const DEFAULT_MAX_SYMBOLS_PER_CYCLE = 25;
export const MAX_SYMBOLS_PER_CYCLE = 100;

function cleanSymbol(value) {
  const s = String(value ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) ? s : null;
}

function clampCap(value, fallback = DEFAULT_MAX_SYMBOLS_PER_CYCLE) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, MAX_SYMBOLS_PER_CYCLE);
}

function addCandidate(map, symbol, source, score, reason) {
  const sym = cleanSymbol(symbol);
  if (!sym) return;
  const row = map.get(sym) ?? { symbol: sym, sources: new Set(), reasons: [], score: 0 };
  row.sources.add(source);
  row.reasons.push(reason);
  row.score += score;
  map.set(sym, row);
}

function parseAffectedSymbols(detail) {
  try {
    const parsed = JSON.parse(detail ?? '{}');
    return Array.isArray(parsed?.affected_symbols) ? parsed.affected_symbols : [];
  } catch {
    return [];
  }
}

export function loadStoredUniverseSignals(db, { since = null, limit = 100 } = {}) {
  const params = [];
  const newsWhere = since ? 'WHERE received_at >= ?' : '';
  if (since) params.push(since);
  const news = db.prepare(
    `SELECT ticker FROM news_events ${newsWhere}
      ORDER BY received_at DESC, id DESC LIMIT ?`
  ).all(...params, limit);

  const sentimentParams = [];
  const sentimentWhere = since ? `JOIN news_events n ON n.id = s.news_event_id WHERE n.received_at >= ?` : '';
  if (since) sentimentParams.push(since);
  const scores = db.prepare(
    `SELECT s.detail FROM sentiment_scores s ${sentimentWhere}
      ORDER BY s.id DESC LIMIT ?`
  ).all(...sentimentParams, limit);

  return {
    newsSymbols: news.map((r) => r.ticker).filter(Boolean),
    affectedSymbols: scores.flatMap((r) => parseAffectedSymbols(r.detail)),
  };
}

export function rankCandidateUniverse({
  baseSymbols = [],
  newsSymbols = [],
  affectedSymbols = [],
  maxSymbols = DEFAULT_MAX_SYMBOLS_PER_CYCLE,
} = {}) {
  const cap = clampCap(maxSymbols);
  const map = new Map();
  for (const symbol of baseSymbols) addCandidate(map, symbol, 'base', 100, 'user base universe');
  for (const symbol of newsSymbols) addCandidate(map, symbol, 'stored_news', 10, 'fresh stored news relevance');
  for (const symbol of affectedSymbols) addCandidate(map, symbol, 'model_affected_symbol', 20, 'model identified affected symbol');

  const ranked = [...map.values()].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  return ranked.map((row, index) => ({
    symbol: row.symbol,
    selected: index < cap,
    rankScore: row.score,
    reasons: [...new Set(row.reasons)],
    source: [...row.sources].sort().join('+'),
    skippedReason: index < cap ? null : `symbol cap reached (${cap})`,
  }));
}

export function selectCandidateUniverse(db, {
  baseSymbols = [],
  since = null,
  maxSymbols = DEFAULT_MAX_SYMBOLS_PER_CYCLE,
  cycleAt = new Date().toISOString(),
  persist = true,
} = {}) {
  const signals = loadStoredUniverseSignals(db, { since });
  const ranked = rankCandidateUniverse({ baseSymbols, ...signals, maxSymbols });
  if (persist) {
    insertUniverseSelections(db, ranked.map((r) => ({
      cycleAt,
      symbol: r.symbol,
      selected: r.selected,
      rankScore: r.rankScore,
      reasons: r.reasons,
      skippedReason: r.skippedReason,
      source: r.source,
    })));
  }
  return {
    selectedSymbols: ranked.filter((r) => r.selected).map((r) => r.symbol),
    ranked,
  };
}
