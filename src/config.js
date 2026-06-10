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
    risk: Object.freeze({
      maxDailyLossUsd: Number(env.MAX_DAILY_LOSS_USD ?? 100),
      maxPositionSizeUsd: Number(env.MAX_POSITION_SIZE_USD ?? 500),
      maxTradesPerDay: Number(env.MAX_TRADES_PER_DAY ?? 10),
      maxTotalExposureUsd: Number(env.MAX_TOTAL_EXPOSURE_USD ?? 1000),
    }),
  });
}

export default loadConfig;
