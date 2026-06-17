// src/config.js — Safe environment configuration for ExaltedFable.
//
// Rules enforced here:
// - LIVE_TRADING_ENABLED defaults to false.
// - Live trading is HARD-BLOCKED unless BOTH flags are explicitly "true":
//     LIVE_TRADING_ENABLED=true
//     CONFIRM_LIVE_TRADING_I_UNDERSTAND_RISK=true
//   Even then, nothing in this codebase uses live trading yet.
// - DATABASE_URL supports sqlite:// URLs and resolves them to a local path.
//
// Timestamp convention (project-wide): UTC ISO-8601 text, e.g. "2026-06-09T14:30:00.000Z".

import path from 'node:path';

const SQLITE_URL_PREFIX = 'sqlite://';
const DEFAULT_DATABASE_URL = 'sqlite://data/exalted_fable.sqlite';

/** Parse a string env var as a strict boolean. Only "true" (case-insensitive) is true. */
function envBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).trim().toLowerCase() === 'true';
}

/** Parse a sqlite:// URL (or plain path) into an absolute filesystem path. */
export function parseDatabaseUrl(databaseUrl, baseDir = process.cwd()) {
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    throw new Error('DATABASE_URL must be a non-empty string');
  }
  let dbPath = databaseUrl;
  if (databaseUrl.startsWith(SQLITE_URL_PREFIX)) {
    dbPath = databaseUrl.slice(SQLITE_URL_PREFIX.length);
  } else if (databaseUrl.includes('://')) {
    throw new Error(
      `Unsupported DATABASE_URL scheme: "${databaseUrl}". Only sqlite:// is supported for now.`
    );
  }
  if (!dbPath) {
    throw new Error(`DATABASE_URL "${databaseUrl}" contains no path`);
  }
  return path.isAbsolute(dbPath) ? path.normalize(dbPath) : path.resolve(baseDir, dbPath);
}

/**
 * Build the config object from an env map (defaults to process.env).
 * Accepting `env` as a parameter keeps this pure and testable.
 */
export function loadConfig(env = process.env) {
  const liveTradingRequested = envBool(env.LIVE_TRADING_ENABLED, false);
  const liveTradingConfirmed = envBool(env.CONFIRM_LIVE_TRADING_I_UNDERSTAND_RISK, false);

  if (liveTradingRequested && !liveTradingConfirmed) {
    throw new Error(
      'LIVE_TRADING_ENABLED=true requires CONFIRM_LIVE_TRADING_I_UNDERSTAND_RISK=true. ' +
        'Live trading is not supported by this codebase yet; remove LIVE_TRADING_ENABLED.'
    );
  }

  return Object.freeze({
    databaseUrl: env.DATABASE_URL || DEFAULT_DATABASE_URL,
    databasePath: parseDatabaseUrl(env.DATABASE_URL || DEFAULT_DATABASE_URL),
    // True only if both explicit flags are set. No code path consumes this for
    // order routing — it exists solely so the risk engine can assert it is false.
    liveTradingEnabled: liveTradingRequested && liveTradingConfirmed,
    paperTrading: true, // paper-only system; not configurable
    // Alpaca credentials for the news HTTP transport. Read ONLY here; held
    // in memory only; never logged, printed, persisted, or normalized.
    // Both null by default — real transports must throw "not configured"
    // rather than auto-enabling when keys happen to exist.
    alpacaNews: Object.freeze({
      keyId: env.ALPACA_API_KEY_ID || null,
      secretKey: env.ALPACA_API_SECRET_KEY || null,
    }),
    // Model-backed classifier credentials/config. Read ONLY here; held in
    // memory only; never logged, printed, persisted, or normalized.
    // anthropicApiKey is null by default — the real model classifier must
    // throw "not configured" rather than auto-enabling when a key exists.
    // classifierModel is just an identifier (not a secret); it defaults to the
    // latest Opus and can be overridden to trade cost/quality.
    model: Object.freeze({
      anthropicApiKey: env.ANTHROPIC_API_KEY || null,
      classifierModel: env.MODEL_CLASSIFIER_MODEL || 'claude-opus-4-8',
    }),
    risk: Object.freeze({
      maxDailyLossUsd: Number(env.MAX_DAILY_LOSS_USD ?? 100),
      maxPositionSizeUsd: Number(env.MAX_POSITION_SIZE_USD ?? 500),
      maxTradesPerDay: Number(env.MAX_TRADES_PER_DAY ?? 10),
      maxTotalExposureUsd: Number(env.MAX_TOTAL_EXPOSURE_USD ?? 1000),
    }),
  });
}

export default loadConfig;
