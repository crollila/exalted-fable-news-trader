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

/** Parse a float env var, clamped to [min,max]; junk/empty -> default. */
function envNum(value, defaultValue, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(Math.max(n, min), max);
}

/** Parse an integer env var, clamped to [min,max]; junk/empty -> default. */
function envInt(value, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) return defaultValue;
  return Math.min(Math.max(n, min), max);
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
    // Benzinga News API credentials. Read ONLY here; held in memory only;
    // never logged, printed, persisted, or normalized. The transport sends the
    // key in an Authorization header (not the request URL).
    benzingaNews: Object.freeze({
      apiKey: env.BENZINGA_API_KEY || null,
    }),
    // Model-backed classifier credentials/config. Read ONLY here; held in
    // memory only; never logged, printed, persisted, or normalized.
    // OpenAI is the production classifier. The OpenAI model id is intentionally
    // not defaulted in code: set OPENAI_MODEL locally so startup can show the
    // configured model name without guessing. Anthropic remains optional only
    // through an explicit --classifier anthropic request.
    model: Object.freeze({
      openaiApiKey: env.OPENAI_API_KEY || null,
      openaiModel: env.OPENAI_MODEL || null,
      anthropicApiKey: env.ANTHROPIC_API_KEY || null,
      anthropicModel: env.ANTHROPIC_MODEL || env.MODEL_CLASSIFIER_MODEL || null,
      classifierModel: env.ANTHROPIC_MODEL || env.MODEL_CLASSIFIER_MODEL || null,
    }),
    // Alpaca PAPER-trading credentials. Reuses the account-level Alpaca key
    // pair (the SAME ALPACA_API_KEY_ID/SECRET env vars the news + trades
    // clients use) — on a paper account these keys authorize the paper trading
    // API, so no new secrets are required. Read ONLY here; held in memory only;
    // never logged, printed, persisted, or normalized. Both null by default so
    // the paper client must throw "not configured" rather than auto-enabling.
    //
    // IMPORTANT: there is intentionally NO base-URL field here. The paper
    // endpoint is hard-coded inside src/paper/alpacaPaperClient.js and there is
    // NO live-endpoint configuration anywhere — live trading stays impossible.
    alpacaPaper: Object.freeze({
      keyId: env.ALPACA_API_KEY_ID || null,
      secretKey: env.ALPACA_API_SECRET_KEY || null,
    }),
    paperCapabilities: Object.freeze({
      enableShorts: envBool(env.PAPER_ENABLE_SHORTS, false),
      enableOptions: envBool(env.PAPER_ENABLE_OPTIONS, false),
      enableMargin: envBool(env.PAPER_ENABLE_MARGIN, false),
    }),
    // Monitored PAPER option execution knobs (entry/exit risk + timing), all
    // conservative, bounded, and overridable via .env. These do NOT enable
    // options — PAPER_ENABLE_OPTIONS + CLI gates + --execute-paper still apply.
    // Percentages are fractions (0.5 = 50%); minutes are whole minutes.
    optionExecution: Object.freeze({
      takeProfitPct: envNum(env.PAPER_OPTION_TP_PCT, 0.5, { min: 0.05, max: 5 }),
      stopLossPct: envNum(env.PAPER_OPTION_SL_PCT, 0.5, { min: 0.05, max: 1 }),
      maxHoldMinutes: envInt(env.PAPER_OPTION_MAX_HOLD_MIN, 240, { min: 5, max: 390 }),
      entryTimeoutMinutes: envInt(env.PAPER_OPTION_ENTRY_TIMEOUT_MIN, 10, { min: 1, max: 120 }),
      exitRetryMinutes: envInt(env.PAPER_OPTION_EXIT_RETRY_MIN, 5, { min: 1, max: 60 }),
      noEntryBeforeCloseMinutes: envInt(env.PAPER_OPTION_NO_ENTRY_BEFORE_CLOSE_MIN, 30, { min: 0, max: 180 }),
      forceCloseBeforeCloseMinutes: envInt(env.PAPER_OPTION_FORCE_CLOSE_BEFORE_CLOSE_MIN, 15, { min: 1, max: 120 }),
      limitSlippagePct: envNum(env.PAPER_OPTION_LIMIT_SLIPPAGE_PCT, 0.05, { min: 0, max: 0.5 }),
    }),
    // Discord delivery for end-of-day PAPER reports. The webhook URL is
    // SECRET-ish (it embeds a token) — read ONLY here, held in memory only,
    // never printed, logged, returned, or persisted. serverId/channelId are
    // non-secret metadata (ids only) used for sanitized display/validation; they
    // are NOT sufficient to post — only webhookUrl can send. All null by default
    // so the Discord client must throw "not configured" rather than auto-enable.
    discord: Object.freeze({
      webhookUrl: env.DISCORD_WEBHOOK_URL || null,
      serverId: env.DISCORD_SERVER_ID || null,
      channelId: env.DISCORD_CHANNEL_ID || null,
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
