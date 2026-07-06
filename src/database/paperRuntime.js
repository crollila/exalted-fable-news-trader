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
  if (value === null || value === undefined || value === '') return null;
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
  entryFilledQty: 'entry_filled_qty',
  entryFilledAvgPrice: 'entry_filled_avg_price',
  entryFilledAt: 'entry_filled_at',
  openedAt: 'opened_at',
  premiumEntry: 'premium_entry',
  notionalEntry: 'notional_entry',
  exitOrderId: 'exit_order_id',
  exitOrderStatus: 'exit_order_status',
  exitLimitPrice: 'exit_limit_price',
  exitFilledQty: 'exit_filled_qty',
  exitFilledAvgPrice: 'exit_filled_avg_price',
  exitFilledAt: 'exit_filled_at',
  premiumExit: 'premium_exit',
  notionalExit: 'notional_exit',
  realizedPnlUsd: 'realized_pnl_usd',
  exitReason: 'exit_reason',
  exitAttempts: 'exit_attempts',
  closedAt: 'closed_at',
  lastCheckedAt: 'last_checked_at',
  brokerPositionQty: 'broker_position_qty',
  brokerPositionMarketValue: 'broker_position_market_value',
  brokerUnrealizedPl: 'broker_unrealized_pl',
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
  providerStatus: 'provider_status_json',
  providerCounts: 'provider_counts_json',
  batchCounts: 'batch_counts_json',
  backlogCounts: 'backlog_counts_json',
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
  'providerStatus',
  'providerCounts',
  'batchCounts',
  'backlogCounts',
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

const PAPER_TRADE_BROKER_COLUMNS = Object.freeze({
  brokerOrderId: 'broker_order_id',
  brokerClientOrderId: 'broker_client_order_id',
  brokerOrderStatus: 'broker_order_status',
  brokerOrderType: 'broker_order_type',
  brokerSubmittedAt: 'broker_submitted_at',
  brokerFilledQty: 'broker_filled_qty',
  brokerFilledAvgPrice: 'broker_filled_avg_price',
  brokerFilledAt: 'broker_filled_at',
  brokerCanceledAt: 'broker_canceled_at',
  brokerExpiredAt: 'broker_expired_at',
  brokerReplacedAt: 'broker_replaced_at',
  brokerUpdatedAt: 'broker_updated_at',
  brokerReconciledAt: 'broker_reconciled_at',
  brokerTruthState: 'broker_truth_state',
  brokerPositionQty: 'broker_position_qty',
  brokerPositionMarketValue: 'broker_position_market_value',
  brokerUnrealizedPl: 'broker_unrealized_pl',
  brokerRealizedPnlUsd: 'broker_realized_pnl_usd',
  fillPrice: 'fill_price',
  entryAt: 'entry_at',
  status: 'status',
  pnlUsd: 'pnl_usd',
});

/** Generic whitelisted update for one equity paper row's broker-truth fields. */
export function updatePaperTradeBrokerTruth(db, id, updates = {}) {
  const rowId = positiveInt('id', id);
  const sets = [];
  const values = {};
  for (const [key, column] of Object.entries(PAPER_TRADE_BROKER_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    sets.push(`${column} = @${key}`);
    values[key] = updates[key] === undefined ? null : updates[key];
  }
  if (sets.length === 0) return { changes: 0 };
  values.id = rowId;
  const run = db.prepare(`UPDATE paper_trades SET ${sets.join(', ')} WHERE id = @id`).run(values);
  return { changes: run.changes };
}

/** Bot-owned equity rows eligible for broker reconciliation. */
export function listPaperTradesForBrokerReconciliation(db, { limit = 500 } = {}) {
  return db
    .prepare(
      `SELECT *
         FROM paper_trades
        WHERE broker_order_id IS NOT NULL
           OR trade_reason LIKE '%paper order %'
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(Number.parseInt(limit, 10) || 500);
}

const SIZING_MODES = new Set(['cold_start', 'evidence_weighted', 'abstain']);

function boundedText(value, max = 500) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

function boolInt(value) {
  return value === true ? 1 : value === false ? 0 : null;
}

/** Persist one sanitized PAPER equity sizing decision. */
export function insertEquitySizingDecision(
  db,
  {
    paperTradeId = null,
    rejectedTradeId = null,
    newsEventId = null,
    ticker,
    side,
    manualOverride = false,
    sizingMode = 'abstain',
    evidenceTier = null,
    evidenceCount = 0,
    evidenceQuality = 'none',
    model = null,
    promptVersion = null,
    newsType = null,
    direction = null,
    scoreBucket = null,
    requestedTargetWeight = null,
    requestedNotional = null,
    requestedQuantity = null,
    approvedTargetWeight = null,
    approvedNotional = null,
    approvedQuantity = null,
    referencePrice = null,
    accountEquity = null,
    currentOwnedExposure = null,
    riskApproved = null,
    riskReason = null,
    explanation,
    warnings = [],
    effectiveRiskCaps = null,
  } = {}
) {
  const mode = SIZING_MODES.has(String(sizingMode)) ? String(sizingMode) : 'abstain';
  const cleanSide = String(side ?? '').trim();
  if (cleanSide !== 'buy' && cleanSide !== 'sell') {
    throw new Error('insertEquitySizingDecision: side must be buy/sell');
  }
  const run = db
    .prepare(
      `INSERT INTO paper_equity_sizing_decisions
         (paper_trade_id, rejected_trade_id, news_event_id, ticker, side,
          manual_override, sizing_mode, evidence_tier, evidence_count,
          evidence_quality, model, prompt_version, news_type, direction,
          score_bucket, requested_target_weight, requested_notional,
          requested_quantity, approved_target_weight, approved_notional,
          approved_quantity, reference_price, account_equity,
          current_owned_exposure, risk_approved, risk_reason, explanation,
          warnings_json, effective_risk_caps_json)
       VALUES
         (@paperTradeId, @rejectedTradeId, @newsEventId, @ticker, @side,
          @manualOverride, @sizingMode, @evidenceTier, @evidenceCount,
          @evidenceQuality, @model, @promptVersion, @newsType, @direction,
          @scoreBucket, @requestedTargetWeight, @requestedNotional,
          @requestedQuantity, @approvedTargetWeight, @approvedNotional,
          @approvedQuantity, @referencePrice, @accountEquity,
          @currentOwnedExposure, @riskApproved, @riskReason, @explanation,
          @warningsJson, @effectiveRiskCapsJson)`
    )
    .run({
      paperTradeId: intOrNull(paperTradeId),
      rejectedTradeId: intOrNull(rejectedTradeId),
      newsEventId: intOrNull(newsEventId),
      ticker: requiredString('ticker', ticker).toUpperCase(),
      side: cleanSide,
      manualOverride: manualOverride ? 1 : 0,
      sizingMode: mode,
      evidenceTier: boundedText(evidenceTier, 80),
      evidenceCount: Math.max(0, Number.parseInt(evidenceCount, 10) || 0),
      evidenceQuality: requiredString('evidenceQuality', evidenceQuality),
      model: boundedText(model, 120),
      promptVersion: boundedText(promptVersion, 80),
      newsType: boundedText(newsType, 80),
      direction: boundedText(direction, 40),
      scoreBucket: boundedText(scoreBucket, 120),
      requestedTargetWeight: finiteOrNull(requestedTargetWeight),
      requestedNotional: finiteOrNull(requestedNotional),
      requestedQuantity: intOrNull(requestedQuantity),
      approvedTargetWeight: finiteOrNull(approvedTargetWeight),
      approvedNotional: finiteOrNull(approvedNotional),
      approvedQuantity: intOrNull(approvedQuantity),
      referencePrice: finiteOrNull(referencePrice),
      accountEquity: finiteOrNull(accountEquity),
      currentOwnedExposure: finiteOrNull(currentOwnedExposure),
      riskApproved: boolInt(riskApproved),
      riskReason: boundedText(riskReason, 500),
      explanation: requiredString('explanation', boundedText(explanation, 700)),
      warningsJson: asJson((warnings ?? []).map((w) => boundedText(w, 300)).filter(Boolean), []),
      effectiveRiskCapsJson: effectiveRiskCaps ? asJson(effectiveRiskCaps, {}) : null,
    });
  return { id: Number(run.lastInsertRowid) };
}

export function listEquitySizingDecisions(db, { day = null, session = null, limit = 100 } = {}) {
  const cap = Number.parseInt(limit, 10) || 100;
  if (session) {
    const end = session.ended_at ?? new Date().toISOString();
    return db
      .prepare(
        `SELECT *
           FROM paper_equity_sizing_decisions
          WHERE created_at >= ? AND created_at <= ?
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(session.started_at, end, cap);
  }
  if (day) {
    return db
      .prepare(
        `SELECT *
           FROM paper_equity_sizing_decisions
          WHERE substr(created_at, 1, 10) = ?
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(requiredString('day', day), cap);
  }
  return db
    .prepare(
      `SELECT *
         FROM paper_equity_sizing_decisions
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(cap);
}

/** Bot-owned, broker-confirmed equity outcomes eligible for sizing evidence. */
export function listBrokerConfirmedEquityOutcomes(db, { limit = 500 } = {}) {
  return db
    .prepare(
      `SELECT
          pt.id AS paper_trade_id,
          pt.news_event_id,
          pt.ticker,
          pt.side,
          pt.broker_filled_qty,
          pt.broker_filled_avg_price,
          pt.broker_realized_pnl_usd,
          COALESCE(sd.model, s.model) AS model,
          COALESCE(sd.prompt_version, s.prompt_version) AS prompt_version,
          s.sentiment_score,
          s.impact_score,
          s.confidence,
          COALESCE(sd.direction, s.direction) AS direction,
          COALESCE(sd.news_type, s.news_type, n.news_type) AS news_type
         FROM paper_trades pt
         LEFT JOIN paper_equity_sizing_decisions sd
           ON sd.paper_trade_id = pt.id AND sd.manual_override = 0
         JOIN sentiment_scores s ON s.news_event_id = pt.news_event_id
         LEFT JOIN news_events n ON n.id = pt.news_event_id
        WHERE (pt.broker_order_id IS NOT NULL OR pt.trade_reason LIKE '%paper order %')
          AND pt.news_event_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM paper_equity_sizing_decisions sm
             WHERE sm.paper_trade_id = pt.id AND sm.manual_override = 1
          )
          AND (
            sd.id IS NOT NULL OR
            (SELECT COUNT(*) FROM sentiment_scores sx WHERE sx.news_event_id = pt.news_event_id) = 1
          )
          AND pt.status = 'closed'
          AND pt.broker_truth_state IN ('filled','partially_filled','closed')
          AND pt.broker_filled_qty IS NOT NULL
          AND pt.broker_filled_qty > 0
          AND pt.broker_filled_avg_price IS NOT NULL
          AND pt.broker_filled_avg_price > 0
          AND pt.broker_realized_pnl_usd IS NOT NULL
        ORDER BY pt.id DESC
        LIMIT ?`
    )
    .all(Number.parseInt(limit, 10) || 500);
}

/** Current bot-owned equity exposure by ticker/side from reconciled rows only. */
export function getOwnedEquityExposureSnapshot(db, { limit = 500 } = {}) {
  const rows = db
    .prepare(
      `SELECT ticker, side, broker_filled_qty, broker_filled_avg_price
         FROM paper_trades
        WHERE (broker_order_id IS NOT NULL OR trade_reason LIKE '%paper order %')
          AND status = 'open'
          AND broker_truth_state IN ('filled','partially_filled')
          AND broker_filled_qty IS NOT NULL
          AND broker_filled_qty > 0
          AND broker_filled_avg_price IS NOT NULL
          AND broker_filled_avg_price > 0
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(Number.parseInt(limit, 10) || 500);
  const byTickerSide = {};
  let grossExposure = 0;
  let openPositionCount = 0;
  for (const row of rows) {
    const ticker = String(row.ticker ?? '').trim().toUpperCase();
    const side = String(row.side ?? '').trim();
    const notional = Math.abs((Number(row.broker_filled_qty) || 0) * (Number(row.broker_filled_avg_price) || 0));
    if (!ticker || !side || !(notional > 0)) continue;
    const key = `${ticker}|${side}`;
    byTickerSide[key] = (byTickerSide[key] ?? 0) + notional;
    grossExposure += notional;
    openPositionCount += 1;
  }
  return {
    byTickerSide,
    grossExposure,
    openPositionCount,
    dataQuality: 'broker_confirmed',
  };
}

export function getPaperEventAttemptStats(db, eventId) {
  const id = intOrNull(eventId);
  if (!id || id <= 0) return { eventId: null, tradeAttempts: 0, rejectionAttempts: 0, totalAttempts: 0, duplicateAttempt: false };
  const trades = db.prepare('SELECT COUNT(*) AS n FROM paper_trades WHERE news_event_id = ?').get(id)?.n ?? 0;
  const rejections = db.prepare('SELECT COUNT(*) AS n FROM rejected_trades WHERE news_event_id = ?').get(id)?.n ?? 0;
  const total = Number(trades) + Number(rejections);
  return {
    eventId: id,
    tradeAttempts: Number(trades),
    rejectionAttempts: Number(rejections),
    totalAttempts: total,
    duplicateAttempt: total > 0,
  };
}

export function insertDuplicateSuppressionAudit(
  db,
  {
    suppressedNewsEventId,
    suppressedProvider,
    suppressedProviderEventId = null,
    keptNewsEventId,
    keptProvider,
    keptProviderEventId = null,
    signalIdentityHash,
    identitySummary,
    duplicateWindowMinutes,
    reason,
  } = {}
) {
  const run = db
    .prepare(
      `INSERT INTO paper_duplicate_suppression_audits
         (suppressed_news_event_id, suppressed_provider, suppressed_provider_event_id,
          kept_news_event_id, kept_provider, kept_provider_event_id,
          signal_identity_hash, identity_summary, duplicate_window_minutes, reason)
       VALUES
         (@suppressedNewsEventId, @suppressedProvider, @suppressedProviderEventId,
          @keptNewsEventId, @keptProvider, @keptProviderEventId,
          @signalIdentityHash, @identitySummary, @duplicateWindowMinutes, @reason)`
    )
    .run({
      suppressedNewsEventId: positiveInt('suppressedNewsEventId', suppressedNewsEventId),
      suppressedProvider: requiredString('suppressedProvider', suppressedProvider),
      suppressedProviderEventId: boundedText(suppressedProviderEventId, 120),
      keptNewsEventId: positiveInt('keptNewsEventId', keptNewsEventId),
      keptProvider: requiredString('keptProvider', keptProvider),
      keptProviderEventId: boundedText(keptProviderEventId, 120),
      signalIdentityHash: requiredString('signalIdentityHash', boundedText(signalIdentityHash, 120)),
      identitySummary: requiredString('identitySummary', boundedText(identitySummary, 500)),
      duplicateWindowMinutes: positiveInt('duplicateWindowMinutes', duplicateWindowMinutes),
      reason: requiredString('reason', boundedText(reason, 700)),
    });
  return { id: Number(run.lastInsertRowid) };
}

export function listDuplicateSuppressionAudits(db, { day = null, session = null, limit = 100 } = {}) {
  const cap = Number.parseInt(limit, 10) || 100;
  if (session) {
    const end = session.ended_at ?? new Date().toISOString();
    return db
      .prepare(
        `SELECT *
           FROM paper_duplicate_suppression_audits
          WHERE created_at >= ? AND created_at <= ?
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(session.started_at, end, cap);
  }
  if (day) {
    return db
      .prepare(
        `SELECT *
           FROM paper_duplicate_suppression_audits
          WHERE substr(created_at, 1, 10) = ?
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(requiredString('day', day), cap);
  }
  return db
    .prepare(
      `SELECT *
         FROM paper_duplicate_suppression_audits
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(cap);
}

export function insertBrokerAccountSnapshot(
  db,
  {
    runtimeSessionId = null,
    snapshotAt,
    snapshotKind = 'reconcile',
    accountStatus = null,
    equity = null,
    portfolioValue = null,
    cash = null,
    buyingPower = null,
    dataQuality = 'limited',
    warnings = [],
  } = {}
) {
  const run = db
    .prepare(
      `INSERT INTO paper_broker_account_snapshots
         (runtime_session_id, snapshot_at, snapshot_kind, account_status, equity,
          portfolio_value, cash, buying_power, data_quality, warnings_json)
       VALUES
         (@runtimeSessionId, @snapshotAt, @snapshotKind, @accountStatus, @equity,
          @portfolioValue, @cash, @buyingPower, @dataQuality, @warningsJson)`
    )
    .run({
      runtimeSessionId: runtimeSessionId === null || runtimeSessionId === undefined ? null : positiveInt('runtimeSessionId', runtimeSessionId),
      snapshotAt: requiredString('snapshotAt', snapshotAt),
      snapshotKind: requiredString('snapshotKind', snapshotKind),
      accountStatus,
      equity: finiteOrNull(equity),
      portfolioValue: finiteOrNull(portfolioValue),
      cash: finiteOrNull(cash),
      buyingPower: finiteOrNull(buyingPower),
      dataQuality: requiredString('dataQuality', dataQuality),
      warningsJson: asJson(warnings, []),
    });
  return { id: Number(run.lastInsertRowid) };
}

export function getBrokerAccountSnapshot(db, id) {
  return db
    .prepare('SELECT * FROM paper_broker_account_snapshots WHERE id = ?')
    .get(positiveInt('id', id)) ?? null;
}

export function findBaselineBrokerAccountSnapshot(db, { runtimeSessionId = null, day = null } = {}) {
  if (runtimeSessionId === null || runtimeSessionId === undefined) {
    if (day) {
      return db
        .prepare(
          `SELECT *
             FROM paper_broker_account_snapshots
            WHERE runtime_session_id IS NULL
              AND substr(snapshot_at, 1, 10) = ?
              AND equity IS NOT NULL
            ORDER BY snapshot_at ASC, id ASC
            LIMIT 1`
        )
        .get(requiredString('day', day)) ?? null;
    }
    return db
      .prepare(
        `SELECT *
           FROM paper_broker_account_snapshots
          WHERE runtime_session_id IS NULL
            AND equity IS NOT NULL
          ORDER BY snapshot_at ASC, id ASC
          LIMIT 1`
      )
      .get() ?? null;
  }
  return db
    .prepare(
      `SELECT *
         FROM paper_broker_account_snapshots
        WHERE runtime_session_id = ?
          AND equity IS NOT NULL
        ORDER BY snapshot_at ASC, id ASC
        LIMIT 1`
    )
    .get(positiveInt('runtimeSessionId', runtimeSessionId)) ?? null;
}

export function insertStrategyPerformanceSnapshot(
  db,
  {
    runtimeSessionId = null,
    accountSnapshotId = null,
    baselineAccountSnapshotId = null,
    snapshotAt,
    snapshotKind = 'reconcile',
    brokerEquityBaseline = null,
    brokerEquityCurrent = null,
    brokerPortfolioValueCurrent = null,
    brokerAccountReturnPct = null,
    spyBaselineAt = null,
    spyBaselinePrice = null,
    spyBaselineTargetAt = null,
    spyBaselineSource = null,
    spyBaselineAlignmentStatus = null,
    spyCurrentAt = null,
    spyCurrentPrice = null,
    spyCurrentTargetAt = null,
    spyCurrentSource = null,
    spyCurrentAlignmentStatus = null,
    spyUnavailableReason = null,
    spyReturnPct = null,
    brokerAccountExcessReturnPct = null,
    botGrossExposure = null,
    botRealizedPnlUsd = null,
    botOpenPositionCount = 0,
    botOrdersSubmitted = 0,
    botOrdersFilled = 0,
    botOrdersOpen = 0,
    botOrdersCanceled = 0,
    botOrdersRejected = 0,
    botOrdersExpired = 0,
    botOrdersReplaced = 0,
    dataQuality = 'limited',
    warnings = [],
  } = {}
) {
  const optionalId = (name, value) =>
    value === null || value === undefined ? null : positiveInt(name, value);
  const intOrZero = (value) => {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  const run = db
    .prepare(
      `INSERT INTO paper_strategy_performance_snapshots
         (runtime_session_id, account_snapshot_id, baseline_account_snapshot_id,
          snapshot_at, snapshot_kind, broker_equity_baseline, broker_equity_current,
          broker_portfolio_value_current, broker_account_return_pct,
          spy_baseline_at, spy_baseline_price, spy_current_at, spy_current_price,
          spy_baseline_target_at, spy_current_target_at,
          spy_baseline_source, spy_current_source,
          spy_baseline_alignment_status, spy_current_alignment_status,
          spy_unavailable_reason,
          spy_return_pct, broker_account_excess_return_pct, bot_gross_exposure,
          bot_realized_pnl_usd, bot_open_position_count, bot_orders_submitted, bot_orders_filled,
          bot_orders_open, bot_orders_canceled, bot_orders_rejected,
          bot_orders_expired, bot_orders_replaced, data_quality, warnings_json)
       VALUES
         (@runtimeSessionId, @accountSnapshotId, @baselineAccountSnapshotId,
          @snapshotAt, @snapshotKind, @brokerEquityBaseline, @brokerEquityCurrent,
          @brokerPortfolioValueCurrent, @brokerAccountReturnPct,
          @spyBaselineAt, @spyBaselinePrice, @spyCurrentAt, @spyCurrentPrice,
          @spyBaselineTargetAt, @spyCurrentTargetAt,
          @spyBaselineSource, @spyCurrentSource,
          @spyBaselineAlignmentStatus, @spyCurrentAlignmentStatus,
          @spyUnavailableReason,
          @spyReturnPct, @brokerAccountExcessReturnPct, @botGrossExposure,
          @botRealizedPnlUsd, @botOpenPositionCount, @botOrdersSubmitted, @botOrdersFilled,
          @botOrdersOpen, @botOrdersCanceled, @botOrdersRejected,
          @botOrdersExpired, @botOrdersReplaced, @dataQuality, @warningsJson)`
    )
    .run({
      runtimeSessionId: optionalId('runtimeSessionId', runtimeSessionId),
      accountSnapshotId: optionalId('accountSnapshotId', accountSnapshotId),
      baselineAccountSnapshotId: optionalId('baselineAccountSnapshotId', baselineAccountSnapshotId),
      snapshotAt: requiredString('snapshotAt', snapshotAt),
      snapshotKind: requiredString('snapshotKind', snapshotKind),
      brokerEquityBaseline: finiteOrNull(brokerEquityBaseline),
      brokerEquityCurrent: finiteOrNull(brokerEquityCurrent),
      brokerPortfolioValueCurrent: finiteOrNull(brokerPortfolioValueCurrent),
      brokerAccountReturnPct: finiteOrNull(brokerAccountReturnPct),
      spyBaselineAt,
      spyBaselinePrice: finiteOrNull(spyBaselinePrice),
      spyBaselineTargetAt,
      spyBaselineSource,
      spyBaselineAlignmentStatus,
      spyCurrentAt,
      spyCurrentPrice: finiteOrNull(spyCurrentPrice),
      spyCurrentTargetAt,
      spyCurrentSource,
      spyCurrentAlignmentStatus,
      spyUnavailableReason,
      spyReturnPct: finiteOrNull(spyReturnPct),
      brokerAccountExcessReturnPct: finiteOrNull(brokerAccountExcessReturnPct),
      botGrossExposure: finiteOrNull(botGrossExposure),
      botRealizedPnlUsd: finiteOrNull(botRealizedPnlUsd),
      botOpenPositionCount: intOrZero(botOpenPositionCount),
      botOrdersSubmitted: intOrZero(botOrdersSubmitted),
      botOrdersFilled: intOrZero(botOrdersFilled),
      botOrdersOpen: intOrZero(botOrdersOpen),
      botOrdersCanceled: intOrZero(botOrdersCanceled),
      botOrdersRejected: intOrZero(botOrdersRejected),
      botOrdersExpired: intOrZero(botOrdersExpired),
      botOrdersReplaced: intOrZero(botOrdersReplaced),
      dataQuality: requiredString('dataQuality', dataQuality),
      warningsJson: asJson(warnings, []),
    });
  return { id: Number(run.lastInsertRowid) };
}

export function getLatestStrategyPerformanceSnapshot(db, { runtimeSessionId = null, day = null } = {}) {
  if (runtimeSessionId !== null && runtimeSessionId !== undefined) {
    return db
      .prepare(
        `SELECT *
           FROM paper_strategy_performance_snapshots
          WHERE runtime_session_id = ?
          ORDER BY snapshot_at DESC, id DESC
          LIMIT 1`
      )
      .get(positiveInt('runtimeSessionId', runtimeSessionId)) ?? null;
  }
  if (day) {
    return db
      .prepare(
        `SELECT *
           FROM paper_strategy_performance_snapshots
          WHERE substr(snapshot_at, 1, 10) = ?
          ORDER BY snapshot_at DESC, id DESC
          LIMIT 1`
      )
      .get(requiredString('day', day)) ?? null;
  }
  return db
    .prepare(
      `SELECT *
         FROM paper_strategy_performance_snapshots
        ORDER BY snapshot_at DESC, id DESC
        LIMIT 1`
    )
    .get() ?? null;
}

// --- Durable backlog pipeline: terminal dispositions --------------------------
//
// Most terminal states already have a durable home (paper_trades = submitted,
// rejected_trades = signal/risk rejected, paper_duplicate_suppression_audits =
// duplicate-suppressed). Only stale_expired and provider_invalid have no prior
// home, so they get an explicit distinguishable record here.

const EVENT_TERMINAL_STATES = new Set(['stale_expired', 'provider_invalid']);

/** Record a durable terminal disposition for one event (idempotent per event). */
export function insertEventTerminal(
  db,
  { newsEventId, provider = null, terminalState, promptVersion = null, queueAgeMinutes = null, reason } = {}
) {
  const state = String(terminalState ?? '');
  if (!EVENT_TERMINAL_STATES.has(state)) {
    throw new Error(`insertEventTerminal: terminalState must be one of ${[...EVENT_TERMINAL_STATES].join('/')}`);
  }
  const run = db
    .prepare(
      `INSERT OR IGNORE INTO paper_event_terminals
         (news_event_id, provider, terminal_state, prompt_version, queue_age_minutes, reason)
       VALUES (@newsEventId, @provider, @terminalState, @promptVersion, @queueAgeMinutes, @reason)`
    )
    .run({
      newsEventId: positiveInt('newsEventId', newsEventId),
      provider: boundedText(provider, 40),
      terminalState: state,
      promptVersion: boundedText(promptVersion, 80),
      queueAgeMinutes: intOrNull(queueAgeMinutes),
      reason: requiredString('reason', boundedText(reason, 500)),
    });
  return { id: Number(run.lastInsertRowid), inserted: run.changes === 1 };
}

/**
 * Sweep queue entries older than the max queue age into a durable stale_expired
 * terminal, with a persisted sanitized reason. Bounded to a recent band
 * [lowerBoundIso, queueFloorIso) so it never mass-backfills ancient history, and
 * idempotent (already-terminal / already-processed events are skipped).
 * @returns {{ count: number }}
 */
export function sweepStaleQueueEvents(
  db,
  { queueFloorIso, lowerBoundIso, queueAgeMinutes, promptVersion = null } = {}
) {
  const floor = requiredString('queueFloorIso', queueFloorIso);
  const lower = requiredString('lowerBoundIso', lowerBoundIso);
  const ageMin = positiveInt('queueAgeMinutes', queueAgeMinutes);
  const reason = `exceeded max queue age ${ageMin} minutes without a terminal paper decision`;
  const run = db
    .prepare(
      `INSERT OR IGNORE INTO paper_event_terminals
         (news_event_id, provider, terminal_state, prompt_version, queue_age_minutes, reason)
       SELECT n.id, n.provider, 'stale_expired', @promptVersion, @ageMin, @reason
         FROM news_events n
        WHERE n.received_at < @floor
          AND n.received_at >= @lower
          AND NOT EXISTS (SELECT 1 FROM paper_trades pt WHERE pt.news_event_id = n.id)
          AND NOT EXISTS (SELECT 1 FROM rejected_trades rt WHERE rt.news_event_id = n.id)
          AND NOT EXISTS (SELECT 1 FROM paper_duplicate_suppression_audits d WHERE d.suppressed_news_event_id = n.id)
          AND NOT EXISTS (SELECT 1 FROM paper_event_terminals t WHERE t.news_event_id = n.id)`
    )
    .run({ promptVersion: boundedText(promptVersion, 80), ageMin, reason, floor, lower });
  return { count: run.changes };
}

/**
 * Mark freshly-classified events whose stored score is NOT usable
 * (parser_status other than parsed/fallback_used) as a durable provider_invalid
 * terminal. Such events can never produce a usable paper signal.
 * @returns {{ count: number }}
 */
export function markUnusableScoresTerminal(db, eventIds = [], promptVersion) {
  const ids = (eventIds ?? []).map((id) => intOrNull(id)).filter((id) => id && id > 0);
  if (ids.length === 0) return { count: 0 };
  const placeholders = ids.map(() => '?').join(', ');
  const run = db
    .prepare(
      `INSERT OR IGNORE INTO paper_event_terminals
         (news_event_id, provider, terminal_state, prompt_version, queue_age_minutes, reason)
       SELECT n.id, n.provider, 'provider_invalid', s.prompt_version, NULL,
              'model score parser_status ' || COALESCE(s.parser_status, '(none)') || ' not usable for a paper signal'
         FROM news_events n
         JOIN sentiment_scores s ON s.news_event_id = n.id
        WHERE n.id IN (${placeholders})
          AND s.prompt_version = ?
          AND s.parser_status NOT IN ('parsed', 'fallback_used')
          AND NOT EXISTS (SELECT 1 FROM paper_event_terminals t WHERE t.news_event_id = n.id)`
    )
    .run(...ids, requiredString('promptVersion', promptVersion));
  return { count: run.changes };
}

export function listEventTerminals(db, { day = null, session = null, state = null, limit = 500 } = {}) {
  const cap = Number.parseInt(limit, 10) || 500;
  const conds = [];
  const params = [];
  if (state) { conds.push('terminal_state = ?'); params.push(state); }
  if (session) {
    const end = session.ended_at ?? new Date().toISOString();
    conds.push('created_at >= ? AND created_at <= ?');
    params.push(session.started_at, end);
  } else if (day) {
    conds.push('substr(created_at, 1, 10) = ?');
    params.push(requiredString('day', day));
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM paper_event_terminals ${where} ORDER BY id DESC LIMIT ?`).all(...params, cap);
}

/**
 * Unscored, in-window, non-terminal events eligible for classification, oldest
 * first (FIFO, so the closest-to-aging-out are classified before they expire).
 * Bounded; callers derive the total-eligible count from the returned length.
 */
export function selectClassificationBacklog(
  db,
  { promptVersion, allowedSymbols = [], sinceReceivedIso = null, limit = 200 } = {}
) {
  const symbols = (allowedSymbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const conds = [
    'NOT EXISTS (SELECT 1 FROM sentiment_scores s WHERE s.news_event_id = n.id AND s.prompt_version = @promptVersion)',
    'NOT EXISTS (SELECT 1 FROM paper_event_terminals t WHERE t.news_event_id = n.id)',
  ];
  const params = { promptVersion: requiredString('promptVersion', promptVersion) };
  if (sinceReceivedIso) {
    conds.push('n.received_at >= @sinceReceivedIso');
    params.sinceReceivedIso = sinceReceivedIso;
  }
  if (symbols.length > 0) {
    conds.push(`n.ticker IN (${symbols.map((_, i) => `@sym${i}`).join(', ')})`);
    symbols.forEach((s, i) => { params[`sym${i}`] = s; });
  }
  params.limit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 1000);
  return db
    .prepare(
      `SELECT n.id AS id, n.ticker AS ticker, n.provider AS provider, n.received_at AS received_at
         FROM news_events n
        WHERE ${conds.join(' AND ')}
        ORDER BY n.received_at ASC, n.id ASC
        LIMIT @limit`
    )
    .all(params);
}

/** Count scored (any status) in-window events, to distinguish already-processed. */
export function countScoredInWindow(db, { promptVersion, allowedSymbols = [], sinceReceivedIso = null } = {}) {
  const symbols = (allowedSymbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const conds = ['s.prompt_version = @promptVersion'];
  const params = { promptVersion: requiredString('promptVersion', promptVersion) };
  if (sinceReceivedIso) {
    conds.push('n.received_at >= @sinceReceivedIso');
    params.sinceReceivedIso = sinceReceivedIso;
  }
  if (symbols.length > 0) {
    conds.push(`n.ticker IN (${symbols.map((_, i) => `@sym${i}`).join(', ')})`);
    symbols.forEach((s, i) => { params[`sym${i}`] = s; });
  }
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT n.id) AS n
         FROM news_events n
         JOIN sentiment_scores s ON s.news_event_id = n.id
        WHERE ${conds.join(' AND ')}`
    )
    .get(params);
  return Number(row?.n ?? 0);
}

// --- Durable per-provider ingestion cursors ----------------------------------

export function getProviderCursor(db, provider) {
  return db
    .prepare('SELECT * FROM paper_provider_cursors WHERE provider = ?')
    .get(requiredString('provider', provider)) ?? null;
}

export function listProviderCursors(db) {
  return db.prepare('SELECT * FROM paper_provider_cursors ORDER BY provider ASC').all();
}

/** Max published_at among the given event ids (the safe watermark upper bound). */
export function maxPublishedAtForEvents(db, eventIds = []) {
  const ids = (eventIds ?? []).map((id) => intOrNull(id)).filter((id) => id && id > 0);
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => '?').join(', ');
  const row = db.prepare(`SELECT MAX(published_at) AS mx FROM news_events WHERE id IN (${placeholders})`).get(...ids);
  return row?.mx ?? null;
}

/** Advance (or create) a provider cursor after a successful, persisted ingest. */
export function advanceProviderCursor(
  db,
  { provider, cursorValue = null, status = 'ok', pages = 0, truncated = false, attemptedAt = null, advancedAt = null } = {}
) {
  const name = requiredString('provider', provider);
  const at = attemptedAt ?? new Date().toISOString();
  const run = db
    .prepare(
      `INSERT INTO paper_provider_cursors
         (provider, cursor_kind, cursor_value, last_status, last_pages, last_truncated, last_advanced_at, last_attempted_at)
       VALUES (@provider, 'published_watermark', @cursorValue, @status, @pages, @truncated, @advancedAt, @attemptedAt)
       ON CONFLICT(provider) DO UPDATE SET
         cursor_value = COALESCE(excluded.cursor_value, paper_provider_cursors.cursor_value),
         last_status = excluded.last_status,
         last_pages = excluded.last_pages,
         last_truncated = excluded.last_truncated,
         last_advanced_at = CASE WHEN excluded.cursor_value IS NOT NULL
                                 THEN excluded.last_advanced_at
                                 ELSE paper_provider_cursors.last_advanced_at END,
         last_attempted_at = excluded.last_attempted_at,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .run({
      provider: name,
      cursorValue: cursorValue ?? null,
      status: boundedText(status, 40),
      pages: Math.max(0, Number.parseInt(pages, 10) || 0),
      truncated: truncated ? 1 : 0,
      advancedAt: (cursorValue ?? null) ? (advancedAt ?? at) : null,
      attemptedAt: at,
    });
  return { changes: run.changes };
}

/** Retain a provider cursor (no watermark change) after a failed/skipped attempt. */
export function retainProviderCursor(db, { provider, status, pages = 0, truncated = false, attemptedAt = null } = {}) {
  const name = requiredString('provider', provider);
  const at = attemptedAt ?? new Date().toISOString();
  const run = db
    .prepare(
      `INSERT INTO paper_provider_cursors
         (provider, cursor_kind, cursor_value, last_status, last_pages, last_truncated, last_attempted_at)
       VALUES (@provider, 'published_watermark', NULL, @status, @pages, @truncated, @attemptedAt)
       ON CONFLICT(provider) DO UPDATE SET
         last_status = excluded.last_status,
         last_pages = excluded.last_pages,
         last_truncated = excluded.last_truncated,
         last_attempted_at = excluded.last_attempted_at,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .run({
      provider: name,
      status: boundedText(status, 40),
      pages: Math.max(0, Number.parseInt(pages, 10) || 0),
      truncated: truncated ? 1 : 0,
      attemptedAt: at,
    });
  return { changes: run.changes };
}
