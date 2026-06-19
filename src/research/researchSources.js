// src/research/researchSources.js — Approved research/scrape source allow-list.
//
// This is a SOURCE-SELECTION foundation, NOT a scraping engine. It loads and
// validates an approved allow-list and answers "is this URL allow-listed?". It
// performs NO network calls and never fetches anything.
//
// SAFETY:
// - The bot may only ever consider sources in the allow-list — never arbitrary
//   URLs. isAllowedUrl() rejects anything not explicitly allowed.
// - Sources that are disabled, paywalled, auth-required, or scrape_mode
//   'disabled' are excluded from default selection.
// - No source in the committed template is fetch_allowed, and there is no fetch
//   code here — this patch is selection-only.

import fs from 'node:fs';
import path from 'node:path';

export const EXAMPLE_SOURCES_PATH = path.resolve(process.cwd(), 'config', 'research-sources.example.json');

export const VALID_TYPES = Object.freeze(['rss', 'api', 'web_page', 'search_query', 'manual']);
export const VALID_SCRAPE_MODES = Object.freeze(['disabled', 'metadata_only', 'fetch_allowed', 'manual_review_only']);

/** Normalize/validate one raw source. Returns the source or null (with a reason in warnings). */
export function validateSource(raw, warnings = []) {
  if (!raw || typeof raw !== 'object') { warnings.push('source: not an object'); return null; }
  const id = typeof raw.source_id === 'string' ? raw.source_id.trim() : '';
  if (!id) { warnings.push('source: missing source_id'); return null; }
  if (!VALID_TYPES.includes(raw.type)) { warnings.push(`${id}: invalid type`); return null; }
  const scrapeMode = VALID_SCRAPE_MODES.includes(raw.scrape_mode) ? raw.scrape_mode : 'disabled';
  const strArr = (v) => (Array.isArray(v) ? v.map((s) => String(s)).filter(Boolean) : []);
  const upperArr = (v) => (Array.isArray(v) ? v.map((s) => String(s).toUpperCase()).filter(Boolean) : []);
  return {
    sourceId: id,
    name: typeof raw.name === 'string' ? raw.name : id,
    type: raw.type,
    enabled: raw.enabled === true,
    baseUrl: typeof raw.base_url === 'string' ? raw.base_url : '',
    allowedPaths: strArr(raw.allowed_paths),
    disallowedPaths: strArr(raw.disallowed_paths),
    requiresAuth: raw.requires_auth === true,
    paywalled: raw.paywalled === true,
    robotsRequired: raw.robots_required !== false,
    rateLimitPerHour: Number.isFinite(Number(raw.rate_limit_per_hour)) ? Number(raw.rate_limit_per_hour) : 0,
    symbolsSupported: upperArr(raw.symbols_supported),
    topicsSupported: strArr(raw.topics_supported),
    scrapeMode,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

/** Load + validate the approved sources. Read-only; injected fs for tests. */
export function loadResearchSources({ sourcePath = EXAMPLE_SOURCES_PATH, fsImpl = fs } = {}) {
  const warnings = [];
  let parsed = null;
  try {
    if (fsImpl.existsSync(sourcePath)) parsed = JSON.parse(fsImpl.readFileSync(sourcePath, 'utf8'));
  } catch {
    warnings.push('source config unreadable or invalid JSON');
  }
  const rawSources = parsed && Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources = rawSources.map((s) => validateSource(s, warnings)).filter(Boolean);
  return { sources, warnings, path: sourcePath };
}

/** A source is selectable for default (non-fetch) research planning. */
export function isSelectable(source, { includeDisabled = false } = {}) {
  if (!source) return false;
  if (source.scrapeMode === 'disabled') return false;
  if (!includeDisabled && !source.enabled) return false;
  if (source.paywalled || source.requiresAuth) return false; // never select gated sources
  return true;
}

/** A source may be FETCHED only if it explicitly allows it (selection-only patch never sets this true). */
export function isFetchAllowed(source) {
  return Boolean(source) && source.enabled && source.scrapeMode === 'fetch_allowed' && !source.paywalled && !source.requiresAuth;
}

/**
 * Strict allow-list check for a candidate URL. Returns true ONLY when the URL's
 * origin matches an enabled source's base_url, the path is under an allowed_path
 * (if any are listed), not under a disallowed_path, and the source is not
 * paywalled/auth-required. Arbitrary URLs are rejected.
 */
export function isAllowedUrl(url, sources = []) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  for (const s of sources) {
    if (!s.enabled || s.paywalled || s.requiresAuth || s.scrapeMode === 'disabled') continue;
    if (!s.baseUrl) continue;
    let base;
    try { base = new URL(s.baseUrl); } catch { continue; }
    if (base.origin !== u.origin) continue;
    if (s.disallowedPaths.some((p) => u.pathname.startsWith(p))) continue;
    if (s.allowedPaths.length > 0 && !s.allowedPaths.some((p) => u.pathname.startsWith(p))) continue;
    return true;
  }
  return false;
}
