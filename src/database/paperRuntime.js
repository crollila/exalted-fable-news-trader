// src/database/paperRuntime.js - Storage helpers for PAPER runtime audit data.
//
// These helpers are deliberately small and boring: they persist sanitized
// outcomes that other modules already decided. They do not enable trading,
// change settings, fetch network data, or write .env.

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function asJson(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

function requiredString(name, value) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${name} is required`);
  return s;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveInt(name, value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function insertPaperOptionTrade(
  db,
  {
    paperTradeId = null,
    newsEventId = null,
    underlying,
    optionSymbol,
    expiry,
    strike,
    right,
    quantity,
    premiumEntry = null,
    notionalEntry = null,
    strategy,
    strategyRationale = null,
    exitPolicy,
    exitReason = null,
    status = 'open',
    lifecycleState = null,
    entryOrderId = null,
    entryOrderStatus = null,
    entryLimitPrice = null,
    openedAt = null,
  } = {}
) {
  const run = db
    .prepare(
      `INSERT INTO paper_option_trades
         (paper_trade_id, news_event_id, underlying, option_symbol, expiry,
          strike, right, quantity, premium_entry, notional_entry, strategy,
          strategy_rationale, exit_policy, exit_reason, status,
          lifecycle_state, entry_order_id, entry_order_status, entry_limit_price, opened_at)
       VALUES
         (@paperTradeId, @newsEventId, @underlying, @optionSymbol, @expiry,
          @strike, @right, @quantity, @premiumEntry, @notionalEntry, @strategy,
          @strategyRationale, @exitPolicy, @exitReason, @status,
          @lifecycleState, @entryOrderId, @entryOrderStatus, @entryLimitPrice, @openedAt)`
    )
    .run({
      paperTradeId,
      newsEventId,
      underlying: requiredString('underlying', underlying).toUpperCase(),
      optionSymbol: requiredString('optionSymbol', optionSymbol).toUpperCase(),
      expiry: requiredString('expiry', expiry),
      strike: finiteOrNull(strike),
      right: requiredString('right', right),
      quantity: positiveInt('quantity', quantity),
      premiumEntry: finiteOrNull(premiumEntry),
      notionalEntry: finiteOrNull(notionalEntry),
      strategy: requiredString('strategy', strategy),
      strategyRationale,
      exitPolicy: requiredString('exitPolicy', exitPolicy),
      exitReason,
      status,
      lifecycleState: lifecycleState ?? null,
      entryOrderId: entryOrderId ?? null,
      entryOrderStatus: entryOrderStatus ?? null,
      entryLimitPrice: finiteOrNull(entryLimitPrice),
      openedAt: openedAt ?? null,
    });
  return { id: Number(run.lastInsertRowid) };
}

/** Whitelisted lifecycle columns for updatePaperOptionTrade. */
const OPTION_UPDATE_COLUMNS = Object.freeze({
  status: 'status',
  lifecycleState: 'lifecycle_state',
  entryOrderId: 'entry_order_id',
  entryOrderStatus: 'entry_order_status',
  entryLimitPrice: 'entry_limit_price',
  openedAt: 'opened_at',
  premiumEntry: 'premium_entry',
  notionalEntry: 'notional_entry',
  exitOrderId: 'exit_order_id',
  exitOrderStatus: 'exit_order_status',
  exitLimitPrice: 'exit_limit_price',
  premiumExit: 'premium_exit',
  notionalExit: 'notional_exit',
  realizedPnlUsd: 'realized_pnl_usd',
  exitReason: 'exit_reason',
  exitAttempts: 'exit_attempts',
  closedAt: 'closed_at',
  lastCheckedAt: 'last_checked_at',
});

/** Generic whitelisted update for one bot option row's lifecycle fields. */
export function updatePaperOptionTrade(db, id, updates = {}) {
  const rowId = positiveInt('id', id);
  const sets = [];
  const values = {};
  for (const [key, column] of Object.entries(OPTION_UPDATE_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    sets.push(`${column} = @${key}`);
    values[key] = updates[key] === undefined ? null : updates[key];
  }
  if (sets.length === 0) return { changes: 0 };
  values.id = rowId;
  const run = db.prepare(`UPDATE paper_option_trades SET ${sets.join(', ')} WHERE id = @id`).run(values);
  return { changes: run.changes };
}

/** One bot option row by id (or null). */
export function getPaperOptionTradeById(db, id) {
  return db.prepare('SELECT * FROM paper_option_trades WHERE id = ?').get(positiveInt('id', id)) ?? null;
}

/** Active (still-monitored) bot-owned option rows: pending_entry/open/pending_exit/unresolved. */
export function listActiveBotOptionTrades(db, { limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT * FROM paper_option_trades
        WHERE lifecycle_state IN ('pending_entry','open','pending_exit','unresolved')
           OR (lifecycle_state IS NULL AND status = 'open')
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(Number.parseInt(limit, 10) || 200);
}

export function closePaperOptionTrade(
  db,
  { id, premiumExit = null, notionalExit = null, exitReason, closedAt = new Date().toISOString() } = {}
) {
  const rowId = positiveInt('id', id);
  const reason = requiredString('exitReason', exitReason);
  const run = db
    .prepare(
      `UPDATE paper_option_trades
          SET premium_exit = ?,
              notional_exit = ?,
              exit_reason = ?,
              status = 'closed',
              closed_at = ?
        WHERE id = ?`
    )
    .run(finiteOrNull(premiumExit), finiteOrNull(notionalExit), reason, closedAt, rowId);
  return { changes: run.changes };
}

export function listPaperOptionTrades(db, { limit = 50 } = {}) {
  return db
    .prepare('SELECT * FROM paper_option_trades ORDER BY id DESC LIMIT ?')
    .all(Number.parseInt(limit, 10) || 50);
}

export function startPaperRuntimeSession(
  db,
  { sessionDate, startedAt = new Date().toISOString(), status = 'open' } = {}
) {
  const run = db
    .prepare(
      `INSERT INTO paper_runtime_sessions (session_date, started_at, status)
       VALUES (?, ?, ?)`
    )
    .run(requiredString('sessionDate', sessionDate), requiredString('startedAt', startedAt), status);
  return { id: Number(run.lastInsertRowid) };
}

const SESSION_UPDATE_COLUMNS = Object.freeze({
  endedAt: 'ended_at',
  status: 'status',
  cycles: 'cycles',
  freshNewsCount: 'fresh_news_count',
  classificationCount: 'classification_count',
  classificationStatus: 'classification_status_json',
  skippedReasons: 'skipped_reason_json',
  rejectedReasons: 'rejected_reason_json',
  ordersSubmitted: 'orders_submitted',
  orderStatus: 'order_status_json',
  modelRequestCount: 'model_request_count',
  shortsUsed: 'shorts_used',
  optionsUsed: 'options_used',
  marginUsed: 'margin_used',
  eodReportStatus: 'eod_report_status',
  eodReportError: 'eod_report_error',
  eodReportSentAt: 'eod_report_sent_at',
});

const JSON_SESSION_KEYS = new Set([
  'classificationStatus',
  'skippedReasons',
  'rejectedReasons',
  'orderStatus',
]);

export function updatePaperRuntimeSession(db, id, updates = {}) {
  const rowId = positiveInt('id', id);
  const sets = [];
  const values = {};
  for (const [key, column] of Object.entries(SESSION_UPDATE_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    sets.push(`${column} = @${key}`);
    values[key] = JSON_SESSION_KEYS.has(key) ? asJson(updates[key]) : updates[key];
  }
  if (sets.length === 0) return { changes: 0 };
  values.id = rowId;
  const run = db.prepare(
    `UPDATE paper_runtime_sessions
        SET ${sets.join(', ')}, updated_at = ${NOW_SQL}
      WHERE id = @id`
  ).run(values);
  return { changes: run.changes };
}

export function getPaperRuntimeSession(db, id) {
  return db.prepare('SELECT * FROM paper_runtime_sessions WHERE id = ?').get(id) ?? null;
}

export function findOpenPaperRuntimeSession(db, sessionDate) {
  return db
    .prepare(
      `SELECT * FROM paper_runtime_sessions
        WHERE session_date = ? AND status = 'open'
        ORDER BY id DESC LIMIT 1`
    )
    .get(requiredString('sessionDate', sessionDate)) ?? null;
}

export function insertRecommendationAudit(
  db,
  {
    version,
    kind,
    evidenceWindowStart = null,
    evidenceWindowEnd = null,
    sampleSize = 0,
    dataQuality,
    observations = [],
    recommendations = [],
  } = {}
) {
  const run = db
    .prepare(
      `INSERT INTO paper_recommendation_audits
         (version, kind, evidence_window_start, evidence_window_end,
          sample_size, data_quality, observations_json, recommendations_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      requiredString('version', version),
      requiredString('kind', kind),
      evidenceWindowStart,
      evidenceWindowEnd,
      Number.parseInt(sampleSize, 10) || 0,
      requiredString('dataQuality', dataQuality),
      asJson(observations, []),
      asJson(recommendations, [])
    );
  return { id: Number(run.lastInsertRowid) };
}

export function listRecommendationAudits(db, { kind = null, limit = 50 } = {}) {
  if (kind) {
    return db
      .prepare('SELECT * FROM paper_recommendation_audits WHERE kind = ? ORDER BY id DESC LIMIT ?')
      .all(kind, Number.parseInt(limit, 10) || 50);
  }
  return db
    .prepare('SELECT * FROM paper_recommendation_audits ORDER BY id DESC LIMIT ?')
    .all(Number.parseInt(limit, 10) || 50);
}

export function insertUniverseSelections(db, entries = []) {
  const stmt = db.prepare(
    `INSERT INTO paper_universe_selections
       (cycle_at, symbol, selected, rank_score, reasons_json, skipped_reason, source)
     VALUES (@cycleAt, @symbol, @selected, @rankScore, @reasons, @skippedReason, @source)`
  );
  let inserted = 0;
  for (const entry of entries ?? []) {
    stmt.run({
      cycleAt: requiredString('cycleAt', entry.cycleAt),
      symbol: requiredString('symbol', entry.symbol).toUpperCase(),
      selected: entry.selected ? 1 : 0,
      rankScore: finiteOrNull(entry.rankScore),
      reasons: asJson(entry.reasons, []),
      skippedReason: entry.skippedReason ?? null,
      source: requiredString('source', entry.source),
    });
    inserted += 1;
  }
  return { inserted };
}

export function listUniverseSelections(db, { cycleAt = null, limit = 100 } = {}) {
  if (cycleAt) {
    return db
      .prepare('SELECT * FROM paper_universe_selections WHERE cycle_at = ? ORDER BY id ASC LIMIT ?')
      .all(cycleAt, Number.parseInt(limit, 10) || 100);
  }
  return db
    .prepare('SELECT * FROM paper_universe_selections ORDER BY id DESC LIMIT ?')
    .all(Number.parseInt(limit, 10) || 100);
}
