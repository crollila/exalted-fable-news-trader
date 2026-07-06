// src/config/strategySettings.js — Non-secret runtime strategy settings.
//
// Two files:
// - config/strategy-settings.example.json   committed template/defaults.
// - data/strategy-settings.json             local runtime override (gitignored).
//
// HARD RULES:
// - NON-SECRET ONLY. Any key that looks like a secret (KEY/SECRET/TOKEN/WEBHOOK)
//   or LIVE_TRADING_ENABLED is dropped on load (and never written).
// - The bot NEVER writes .env. writeStrategySettings() writes ONLY the runtime
//   data file, and only when a caller explicitly asks (the updater's --write).
// - All values are validated/capped; no unlimited values; interval respects the
//   loop's safety floor.
// - Notes are APPENDED with de-duplication + a hard cap, so the file does not
//   bloat over many learning updates.

import fs from 'node:fs';
import path from 'node:path';
import { MIN_INTERVAL_MINUTES, MAX_ITERATIONS_CAP } from '../paper/paperTradingLoop.js';

export const RUNTIME_SETTINGS_PATH = path.resolve(process.cwd(), 'data', 'strategy-settings.json');
export const EXAMPLE_SETTINGS_PATH = path.resolve(process.cwd(), 'config', 'strategy-settings.example.json');

/** Hard cap on retained notes (oldest dropped first). */
export const NOTES_CAP = 50;

/** Conservative defaults — mirror config/strategy-settings.example.json. */
export const DEFAULT_SETTINGS = Object.freeze({
  symbols: ['AAPL', 'MSFT', 'NVDA'],
  allow_shorts: false,
  allow_options: true,
  allow_margin: false,
  max_order_notional: 500,
  max_option_premium: 250,
  max_symbol_exposure: 1000,
  max_gross_exposure: 5000,
  max_daily_paper_orders: 10,
  max_daily_paper_notional: 5000,
  confidence_threshold: 0.6,
  impact_threshold: 0.5,
  sentiment_threshold: 0.3,
  sizing_min_comparable_sample_size: 10,
  sizing_cold_start_target_weight: 0.0075,
  sizing_max_target_weight: 0.01,
  sizing_enable_confidence_scaling: true,
  sizing_enable_impact_scaling: true,
  exit_take_profit_pct: 0.04,
  exit_stop_loss_pct: 0.035,
  exit_max_hold_minutes: 390,
  exit_learning_enabled: true,
  exit_min_sample_size: 10,
  interval_minutes: 15,
  max_iterations: null,
});

/** Per-field validation/cap specs. Keys NOT listed here are dropped. */
export const SETTING_SPECS = Object.freeze({
  symbols: { kind: 'symbols' },
  allow_shorts: { kind: 'bool' },
  allow_options: { kind: 'bool' },
  allow_margin: { kind: 'bool' },
  max_order_notional: { kind: 'num', min: 1, max: 100000 },
  max_option_premium: { kind: 'num', min: 1, max: 100000 },
  max_symbol_exposure: { kind: 'num', min: 1, max: 1000000 },
  max_gross_exposure: { kind: 'num', min: 1, max: 1000000 },
  max_daily_paper_orders: { kind: 'int', min: 1, max: 500 },
  max_daily_paper_notional: { kind: 'num', min: 1, max: 10000000 },
  confidence_threshold: { kind: 'unit' },
  impact_threshold: { kind: 'unit' },
  sentiment_threshold: { kind: 'unit' },
  sizing_min_comparable_sample_size: { kind: 'int', min: 3, max: 100 },
  sizing_cold_start_target_weight: { kind: 'num', min: 0.0001, max: 0.01 },
  sizing_max_target_weight: { kind: 'num', min: 0.0001, max: 0.01 },
  sizing_enable_confidence_scaling: { kind: 'bool' },
  sizing_enable_impact_scaling: { kind: 'bool' },
  exit_take_profit_pct: { kind: 'num', min: 0.005, max: 0.5 },
  exit_stop_loss_pct: { kind: 'num', min: 0.005, max: 0.25 },
  exit_max_hold_minutes: { kind: 'int', min: 5, max: 10080 },
  exit_learning_enabled: { kind: 'bool' },
  exit_min_sample_size: { kind: 'int', min: 3, max: 100 },
  interval_minutes: { kind: 'int', min: MIN_INTERVAL_MINUTES, max: 1440 },
  max_iterations: { kind: 'optional_int', min: 1, max: MAX_ITERATIONS_CAP },
});

/** Keys that must never appear in strategy settings (defense in depth). */
const FORBIDDEN_KEY = /KEY|SECRET|TOKEN|WEBHOOK|PASSWORD|LIVE_TRADING_ENABLED/i;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function coerceField(spec, value, fallback, warnings, key) {
  switch (spec.kind) {
    case 'bool':
      return value === true || value === false ? value : fallback;
    case 'enum':
      return spec.values.includes(value) ? value : fallback;
    case 'num': {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) { warnings.push(`${key}: invalid, kept ${fallback}`); return fallback; }
      return clamp(n, spec.min, spec.max);
    }
    case 'int': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n <= 0) { warnings.push(`${key}: invalid, kept ${fallback}`); return fallback; }
      return clamp(n, spec.min, spec.max);
    }
    case 'optional_int': {
      if (value === null || value === undefined || value === '') return null;
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n <= 0) { warnings.push(`${key}: invalid, kept ${fallback}`); return fallback; }
      return clamp(n, spec.min, spec.max);
    }
    case 'unit': {
      const n = Number(value);
      if (!Number.isFinite(n)) { warnings.push(`${key}: invalid, kept ${fallback}`); return fallback; }
      return clamp(n, 0, 1);
    }
    case 'symbols':
      return Array.isArray(value)
        ? [...new Set(value.map((s) => String(s).trim().toUpperCase()).filter(Boolean))]
        : fallback;
    case 'strings':
      return Array.isArray(value)
        ? [...new Set(value.map((s) => String(s).trim()).filter(Boolean))]
        : fallback;
    default:
      return fallback;
  }
}

/**
 * Validate/cap a raw settings object against DEFAULT_SETTINGS. Unknown and
 * forbidden (secret-like / live-trading) keys are dropped.
 * @returns {{ settings: object, warnings: string[] }}
 */
export function validateStrategySettings(raw = {}) {
  const warnings = [];
  const settings = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (FORBIDDEN_KEY.test(key)) { warnings.push(`${key}: forbidden key dropped`); continue; }
    const spec = SETTING_SPECS[key];
    if (!spec) continue; // unknown -> ignore
    settings[key] = coerceField(spec, value, DEFAULT_SETTINGS[key], warnings, key);
  }
  return { settings, warnings };
}

/**
 * Load strategy settings: runtime data file if present, else the committed
 * example, else hard defaults. Read-only; injected fs for tests.
 * @returns {{ settings: object, notes: object[], source: string, warnings: string[] }}
 */
export function loadStrategySettings({
  runtimePath = RUNTIME_SETTINGS_PATH, examplePath = EXAMPLE_SETTINGS_PATH, fsImpl = fs,
} = {}) {
  let source = 'defaults';
  let parsed = null;
  for (const [p, label] of [[runtimePath, 'runtime'], [examplePath, 'example']]) {
    try {
      if (p && fsImpl.existsSync(p)) {
        parsed = JSON.parse(fsImpl.readFileSync(p, 'utf8'));
        source = label;
        break;
      }
    } catch {
      /* unreadable/invalid file -> fall through to the next source */
    }
  }
  const rawSettings = parsed && typeof parsed === 'object' ? parsed.settings ?? parsed : {};
  const { settings, warnings } = validateStrategySettings(rawSettings);
  const notes = parsed && Array.isArray(parsed.notes) ? parsed.notes : [];
  return { settings, notes, source, warnings };
}

/**
 * Append new notes to existing notes, DE-DUPLICATING identical entries and
 * capping the total (oldest dropped first) so the file never bloats.
 */
export function appendNotes(existing = [], additions = [], { cap = NOTES_CAP } = {}) {
  const keyOf = (n) => `${n?.field ?? ''}|${n?.to ?? ''}|${n?.reason ?? ''}`;
  const addKeys = new Set((additions ?? []).map(keyOf));
  const kept = (existing ?? []).filter((n) => !addKeys.has(keyOf(n)));
  const merged = [...kept, ...(additions ?? [])];
  return merged.slice(Math.max(0, merged.length - cap));
}

/** Build the on-disk file object (validated settings + capped notes). */
export function buildSettingsFile({ settings, notes = [] }, { now = () => new Date().toISOString() } = {}) {
  const { settings: clean } = validateStrategySettings(settings);
  return { version: 1, updated_at: now(), settings: clean, notes: (notes ?? []).slice(-NOTES_CAP) };
}

/**
 * Write the runtime strategy file (ONLY the data file — never .env). Creates the
 * data/ directory if needed. Injected fs for tests.
 * @returns {{ path: string, file: object }}
 */
export function writeStrategySettings({
  path: outPath = RUNTIME_SETTINGS_PATH, settings, notes = [], fsImpl = fs, now,
} = {}) {
  if (/\.env$/i.test(String(outPath))) {
    throw new Error('writeStrategySettings: refusing to write a .env file');
  }
  const file = buildSettingsFile({ settings, notes }, { now });
  const dir = path.dirname(outPath);
  if (fsImpl.mkdirSync) fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return { path: outPath, file };
}
