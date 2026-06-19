// src/research/scrapeTargetSelector.js — SELECTION-ONLY research-target planner.
//
// Given the approved source allow-list + the symbols/topics the day's trading
// suggests are worth researching, it RANKS and SELECTS which approved sources to
// look at next. It performs NO network calls and never fetches — output is a
// PLAN, not content. Gated sources (disabled/paywalled/auth-required) are never
// selected. Arbitrary URLs are impossible here: only allow-listed sources flow in.

import { isSelectable } from './researchSources.js';

/**
 * Rank + select approved research targets. Pure (no network).
 *
 * @param {object} args
 * @param {object[]} args.sources       validated sources (researchSources.loadResearchSources)
 * @param {string[]} [args.symbols]     symbols to research
 * @param {string[]} [args.topics]      topics to prioritize (e.g. from learning research focus)
 * @param {number} [args.limit]
 * @param {boolean} [args.includeDisabled]
 * @returns {{ scanned:number, selectable:number, targets:object[] }}
 */
export function selectScrapeTargets({ sources = [], symbols = [], topics = [], limit = 10, includeDisabled = false } = {}) {
  const wantSymbols = (symbols ?? []).map((s) => String(s).toUpperCase()).filter(Boolean);
  const wantTopics = new Set((topics ?? []).map((t) => String(t)).filter(Boolean));
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;

  const scored = [];
  for (const s of sources) {
    if (!isSelectable(s, { includeDisabled })) continue;
    let score = 1; // base for being an approved, enabled, ungated source
    const why = [];

    const symMatch = s.symbolsSupported.length === 0 ? wantSymbols : s.symbolsSupported.filter((x) => wantSymbols.includes(x));
    if (s.symbolsSupported.length === 0 && wantSymbols.length > 0) { score += 1; why.push('covers all symbols'); }
    else if (symMatch.length > 0) { score += symMatch.length; why.push(`symbols ${symMatch.join(',')}`); }

    const topMatch = s.topicsSupported.filter((t) => wantTopics.has(t));
    if (topMatch.length > 0) { score += 2 * topMatch.length; why.push(`topics ${topMatch.join(',')}`); }

    if (why.length === 0) why.push('approved source');
    scored.push({
      source: s, score, why,
      symbolFocus: (symMatch.length ? symMatch : wantSymbols).slice(0, 10),
      topicFocus: topMatch,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.source.sourceId.localeCompare(b.source.sourceId));

  const targets = scored.slice(0, cap).map(({ source, why, symbolFocus, topicFocus }) => ({
    sourceId: source.sourceId,
    name: source.name,
    type: source.type,
    scrapeMode: source.scrapeMode,
    allowedMode: source.scrapeMode,
    symbolFocus,
    topicFocus,
    rateLimitPerHour: source.rateLimitPerHour,
    fetchDisabled: true, // selection-only: this patch never fetches
    whySelected: why,
  }));
  return { scanned: sources.length, selectable: scored.length, targets };
}

/** Sanitized printable plan. No URLs/secrets — source ids + metadata only. */
export function formatTargetsReport(result, { includeDisabled = false } = {}) {
  const lines = [
    'ExaltedFable — research target selection (SELECTION-ONLY; no fetching)',
    `  approved sources scanned: ${result.scanned}  selectable: ${result.selectable}`,
    `  include-disabled: ${includeDisabled ? 'yes' : 'no'}`,
    `  targets: ${result.targets.length}`,
  ];
  if (result.targets.length === 0) {
    lines.push('  (no eligible approved sources — check config/research-sources.example.json)');
  }
  for (const t of result.targets) {
    lines.push(
      `  • ${t.sourceId} [${t.type}] mode=${t.scrapeMode} rate=${t.rateLimitPerHour}/h fetch=${t.fetchDisabled ? 'disabled' : 'allowed'}`,
      `      focus: symbols=${t.symbolFocus.join(',') || '(any)'} topics=${t.topicFocus.join(',') || '(general)'}`,
      `      why: ${t.whySelected.join('; ')}`
    );
  }
  return lines;
}
