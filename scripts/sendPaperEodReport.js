// scripts/sendPaperEodReport.js — MANUAL end-of-day PAPER report.
//
//   Preview locally (default; sends nothing, needs no webhook):
//     node --env-file=.env scripts/sendPaperEodReport.js --dry-run
//
//   Send to Discord (requires DISCORD_WEBHOOK_URL in .env):
//     node --env-file=.env scripts/sendPaperEodReport.js --send-discord
//
// Builds a sanitized end-of-day narrative from the LOCAL paper_trades /
// rejected_trades tables for one trading day and either prints it (dry run) or
// posts it to the configured Discord webhook. There is no learning-log table
// yet, so the narrative is derived from the order/rejection records; when there
// are none it prints a safe placeholder that still proves Discord delivery.
//
// - MANUAL ONLY: never part of npm test, startup, schedulers, or CI.
// - READ-ONLY over the database (SELECTs only; migrations are idempotent).
// - DRY RUN BY DEFAULT. It posts to Discord ONLY with --send-discord (or
//   --test-message), and only when DISCORD_WEBHOOK_URL is configured.
// - SANITIZED: counts, tickers, sides, statuses, our own rejection-reason
//   strings, and rounded P&L only. NEVER raw model responses, raw news
//   payloads, headlines, API keys, headers, request configs, or the webhook URL.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createDiscordWebhookClient } from '../src/notifications/discordWebhookClient.js';
import {
  getLatestStrategyPerformanceSnapshot,
  listEquitySizingDecisions,
} from '../src/database/paperRuntime.js';
import {
  formatReturn,
  hydratePerformanceSnapshotRow,
} from '../src/paper/brokerTruth.js';
import { getRiskState } from '../src/paper/riskState.js';

/** Short message used by --test-message (proves delivery without a full report). */
export const EOD_TEST_MESSAGE =
  'ExaltedFable end-of-day report test — paper trading reports enabled.';

/** Cap on the per-list samples rendered in the report. */
const LIST_CAP = 10;

/**
 * Parse CLI args. Exported for tests. Dry run is the default; an actual send
 * happens only when --send-discord (or --test-message) is explicitly present.
 *   --day YYYY-MM-DD   --dry-run   --send-discord   --test-message
 *   --session-id N
 */
export function parseArgs(argv) {
  const args = {
    day: null, sessionId: null, send: false, testMessage: false, dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--day' && argv[i + 1]) {
      const v = argv[i + 1].trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) args.day = v;
      i += 1;
    } else if (flag === '--session-id' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) args.sessionId = n;
      i += 1;
    } else if (flag === '--send-discord') {
      args.send = true;
    } else if (flag === '--test-message') {
      args.testMessage = true;
    } else if (flag === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function moneyOrUnavailable(value) {
  if (value === null || value === undefined || value === '') return 'unavailable';
  const n = Number(value);
  return Number.isFinite(n) ? `$${round2(n).toFixed(2)}` : 'unavailable';
}

function parseJsonMap(text) {
  try {
    const parsed = JSON.parse(text ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(text ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeCounts(target, source = {}) {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + (Number(value) || 0);
  }
  return target;
}

function countRows(rows, key) {
  const out = {};
  for (const row of rows) out[row[key] ?? 'unknown'] = (out[row[key] ?? 'unknown'] ?? 0) + 1;
  return out;
}

function activityFilter({ day = null, session = null } = {}) {
  if (session) {
    const end = session.ended_at ?? new Date().toISOString();
    return {
      clause: 'WHERE created_at >= ? AND created_at <= ?',
      params: [session.started_at, end],
      label: `session:${session.id}`,
    };
  }
  return {
    clause: day ? 'WHERE substr(created_at, 1, 10) = ?' : '',
    params: day ? [day] : [],
    label: day ?? 'all-time',
  };
}

function uniqueEvidenceStats(trades = [], rejections = []) {
  const attempts = [...trades, ...rejections].filter((r) => r.news_event_id !== null && r.news_event_id !== undefined);
  const ids = new Set(attempts.map((r) => Number(r.news_event_id)));
  return {
    attemptsWithEventId: attempts.length,
    uniqueEventCount: ids.size,
    duplicateAttemptCount: Math.max(0, attempts.length - ids.size),
  };
}

export function assessEodDataQuality(data, { minSampleSize = 10 } = {}) {
  const warnings = [];
  const uniqueEvents = data.uniqueEventCount ?? 0;
  if ((data.duplicateAttemptCount ?? 0) > 0) {
    warnings.push(`${data.duplicateAttemptCount} duplicate/stale event replay attempt(s) detected; repeated attempts are not independent evidence.`);
  }
  if (uniqueEvents < minSampleSize) {
    warnings.push(`Only ${uniqueEvents} unique event(s), below minimum sample size ${minSampleSize}.`);
  }
  if (!data.session || Number(data.session.cycles ?? 0) <= 0) {
    warnings.push('Session metrics are missing or empty; report conclusions are unreliable.');
  }
  if (!data.brokerTruth?.available) {
    warnings.push('Broker-truth performance snapshot unavailable; broker-confirmed fills, exposure, broker account return, and benchmark comparison are unavailable.');
  } else {
    for (const warning of data.brokerTruth.warnings ?? []) warnings.push(`Broker truth: ${warning}`);
  }
  if ((data.sizing?.coldStartCount ?? 0) > 0) {
    warnings.push(`${data.sizing.coldStartCount} equity sizing decision(s) used conservative cold-start allocation.`);
  }
  if ((data.sizing?.abstainCount ?? 0) > 0) {
    warnings.push(`${data.sizing.abstainCount} equity sizing decision(s) abstained because evidence or required broker/price data was insufficient.`);
  }
  if ((data.sizing?.limitedEvidenceCount ?? 0) > 0) {
    warnings.push(`${data.sizing.limitedEvidenceCount} equity sizing decision(s) had limited comparable broker-confirmed evidence.`);
  }
  return {
    status: warnings.length === 0 ? 'sufficient' : 'limited',
    canRecommend: warnings.length === 0,
    warnings,
    minSampleSize,
    uniqueEventCount: uniqueEvents,
    duplicateAttemptCount: data.duplicateAttemptCount ?? 0,
  };
}

/**
 * Collect sanitized EOD figures from paper_trades / rejected_trades. When `day`
 * is null, all rows are counted (useful for tests/ad-hoc); otherwise rows are
 * filtered to that UTC calendar day by created_at prefix. Reads ONLY whitelisted
 * columns — never headlines, raw_payload, or model responses (those live on
 * other tables and are not joined here).
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string|null} [opts.day]  'YYYY-MM-DD' or null for all-time
 */
export function collectEodData(db, { day = null, sessionId = null } = {}) {
  const session =
    Number.isInteger(Number(sessionId)) && Number(sessionId) > 0
      ? db.prepare('SELECT * FROM paper_runtime_sessions WHERE id = ?').get(Number(sessionId)) ?? null
      : null;
  const filter = activityFilter({ day, session });
  const dayClause = filter.clause;
  const dayParams = filter.params;
  const brokerPerformanceRow = getLatestStrategyPerformanceSnapshot(db, {
    runtimeSessionId: session ? Number(session.id) : null,
    day,
  });
  const brokerPerformance = hydratePerformanceSnapshotRow(brokerPerformanceRow);
  const brokerExposure = brokerPerformance?.exposure ?? null;

  const trades = db
    .prepare(
      `SELECT news_event_id, ticker, side, quantity, fill_price, pnl_usd, status, created_at
         FROM paper_trades ${dayClause}
        ORDER BY id DESC`
    )
    .all(...dayParams);

  const rejections = db
    .prepare(
      `SELECT news_event_id, ticker, side, quantity, reason, created_at
         FROM rejected_trades ${dayClause}
        ORDER BY id DESC`
    )
    .all(...dayParams);

  const sizingRows = listEquitySizingDecisions(db, {
    day: session ? null : day,
    session,
    limit: 500,
  });
  const sizingModeCounts = countRows(sizingRows, 'sizing_mode');
  const sizingWarnings = [];
  for (const row of sizingRows) {
    sizingWarnings.push(...parseJsonArray(row.warnings_json));
  }
  const sizingSamples = sizingRows.slice(0, LIST_CAP).map((row) => ({
    ticker: row.ticker,
    side: row.side,
    mode: row.sizing_mode,
    manualOverride: row.manual_override === 1,
    evidenceTier: row.evidence_tier,
    evidenceCount: row.evidence_count,
    evidenceQuality: row.evidence_quality,
    requestedTargetWeight: row.requested_target_weight,
    requestedNotional: row.requested_notional,
    requestedQuantity: row.requested_quantity,
    approvedTargetWeight: row.approved_target_weight,
    approvedNotional: row.approved_notional,
    approvedQuantity: row.approved_quantity,
    accountEquity: row.account_equity,
    riskApproved: row.risk_approved,
    riskReason: row.risk_reason,
    explanation: row.explanation,
    effectiveRiskCaps: parseJsonObject(row.effective_risk_caps_json),
  }));

  const sessions = db
    .prepare(
      `SELECT cycles, fresh_news_count, classification_count,
              classification_status_json, skipped_reason_json, rejected_reason_json,
              orders_submitted, order_status_json, model_request_count,
              shorts_used, margin_used, eod_report_status
         FROM paper_runtime_sessions ${session ? 'WHERE id = ?' : dayClause}
        ORDER BY id DESC`
    )
    .all(...(session ? [session.id] : dayParams));

  const longCount = trades.filter((t) => t.side === 'buy').length;
  const shortCount = trades.filter((t) => t.side === 'sell').length;
  const fills = trades.filter((t) => t.fill_price !== null && t.fill_price !== undefined).length;
  const orderStatus = countRows(trades, 'status');
  const realizedPnl = trades.reduce((sum, t) => sum + (Number(t.pnl_usd) || 0), 0);
  // Win/loss counts over ALL trades (used by the constraint recommender).
  const winningTrades = trades.filter((t) => Number(t.pnl_usd) > 0).length;
  const losingTrades = trades.filter((t) => Number(t.pnl_usd) < 0).length;

  // Recurring rejection reasons, most common first.
  const reasonCounts = {};
  for (const r of rejections) reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  const rejectionReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => ({ reason, n }));

  // Best/worst ticker by realized P&L (only meaningful once P&L exists).
  const byTicker = {};
  for (const t of trades) byTicker[t.ticker] = (byTicker[t.ticker] ?? 0) + (Number(t.pnl_usd) || 0);
  const tickerPnl = Object.entries(byTicker).sort((a, b) => b[1] - a[1]);
  const openPositions = trades
    .filter((t) => t.status === 'open')
    .map((t) => ({
      ticker: t.ticker,
      side: t.side,
      qty: t.quantity,
      exposure: round2((Number(t.fill_price) || 0) * (Number(t.quantity) || 0)),
    }));
  const openExposure = round2(openPositions.reduce((sum, p) => sum + Math.abs(p.exposure), 0));

  const sessionSummary = {
    sessionId: session ? Number(session.id) : null,
    evidenceScope: filter.label,
    cycles: 0,
    freshNewsCount: 0,
    classificationCount: 0,
    classificationStatus: {},
    skippedReasons: {},
    rejectedReasons: {},
    ordersSubmitted: 0,
    orderStatus: {},
    modelRequestCount: 0,
    shortsUsed: 0,
    marginUsed: 0,
    eodReportStatus: {},
  };
  for (const s of sessions) {
    sessionSummary.cycles += Number(s.cycles) || 0;
    sessionSummary.freshNewsCount += Number(s.fresh_news_count) || 0;
    sessionSummary.classificationCount += Number(s.classification_count) || 0;
    mergeCounts(sessionSummary.classificationStatus, parseJsonMap(s.classification_status_json));
    mergeCounts(sessionSummary.skippedReasons, parseJsonMap(s.skipped_reason_json));
    mergeCounts(sessionSummary.rejectedReasons, parseJsonMap(s.rejected_reason_json));
    sessionSummary.ordersSubmitted += Number(s.orders_submitted) || 0;
    mergeCounts(sessionSummary.orderStatus, parseJsonMap(s.order_status_json));
    sessionSummary.modelRequestCount += Number(s.model_request_count) || 0;
    sessionSummary.shortsUsed += Number(s.shorts_used) || 0;
    sessionSummary.marginUsed += Number(s.margin_used) || 0;
    if (s.eod_report_status) mergeCounts(sessionSummary.eodReportStatus, { [s.eod_report_status]: 1 });
  }
  const evidence = uniqueEvidenceStats(trades, rejections);

  return {
    day,
    session: sessionSummary,
    evidenceScope: filter.label,
    riskState: day ? getRiskState(db, day) : null,
    ...evidence,
    ordersSubmitted: trades.length,
    longCount,
    shortCount,
    fills,
    orderStatus,
    openPositions,
    openExposure,
    brokerTruth: {
      available: Boolean(brokerPerformance),
      performance: brokerPerformance,
      exposure: brokerExposure,
      warnings: brokerPerformance?.warnings ?? ['Broker-truth performance snapshot unavailable.'],
    },
    unrealizedPnl: null,
    realizedPnl: round2(realizedPnl),
    winningTrades,
    losingTrades,
    rejectedCount: rejections.length,
    proposals: trades.length + rejections.length, // proxy until a learning log exists
    rejectionReasons,
    bestTicker: tickerPnl.length > 0 ? tickerPnl[0][0] : null,
    worstTicker: tickerPnl.length > 0 ? tickerPnl[tickerPnl.length - 1][0] : null,
    trades: trades.slice(0, LIST_CAP).map((t) => ({
      ticker: t.ticker,
      side: t.side,
      qty: t.quantity,
      status: t.status,
      fillPrice: t.fill_price,
      pnl: t.pnl_usd,
    })),
    sizing: {
      decisions: sizingRows.length,
      modeCounts: sizingModeCounts,
      coldStartCount: sizingModeCounts.cold_start ?? 0,
      evidenceWeightedCount: sizingModeCounts.evidence_weighted ?? 0,
      abstainCount: sizingModeCounts.abstain ?? 0,
      manualOverrideCount: sizingRows.filter((r) => r.manual_override === 1).length,
      limitedEvidenceCount: sizingRows.filter((r) => r.evidence_quality !== 'sufficient' && r.manual_override !== 1).length,
      warnings: [...new Set(sizingWarnings)].slice(0, LIST_CAP),
      samples: sizingSamples,
    },
  };
}

function brokerTruthSection(data = {}) {
  const brokerTruth = data.brokerTruth ?? {};
  const performance = brokerTruth.performance ?? null;
  const exposure = brokerTruth.exposure ?? performance?.exposure ?? null;
  const lines = ['- Broker truth / benchmark (PAPER) -'];
  if (!performance) {
    lines.push(
      '  Broker-truth snapshot: unavailable',
      '  submitted vs fills:     unavailable',
      '  owned exposure:         unavailable',
      '  broker account return:  unavailable',
      '  owned return:           unavailable',
      '  SPY session return:     unavailable',
      '  account excess vs SPY:  unavailable',
    );
    return lines;
  }

  const orders = performance.broker?.orders ?? {};
  const realizedPnl = exposure?.realizedPnlUsd ?? null;
  lines.push(
    `  snapshot:               ${performance.snapshotAt ?? 'unavailable'} (${performance.dataQuality ?? 'limited'})`,
    `  submitted vs fills:     ${orders.submitted ?? 0} submitted / ${orders.filled ?? 0} broker-confirmed fill(s)`,
    `  open/canceled/rejected/expired: ${orders.open ?? 0} / ${orders.canceled ?? 0} / ${orders.rejected ?? 0} / ${orders.expired ?? 0}`,
    `  replaced:               ${orders.replaced ?? 0}`,
    `  owned gross exposure:   ${moneyOrUnavailable(exposure?.grossExposure)}`,
    `  owned open positions:   ${exposure?.openPositionCount ?? 0}`,
    `  broker-confirmed owned P&L: ${moneyOrUnavailable(realizedPnl)}`,
    `  broker-wide equity:     baseline=${moneyOrUnavailable(performance.brokerEquityBaseline)} current=${moneyOrUnavailable(performance.brokerEquityCurrent)}`,
    `  broker account return:  ${formatReturn(performance.brokerAccountReturn)}`,
    `  owned return:           ${performance.botReturnUnavailableReason ?? 'unavailable'}`,
    `  SPY session return:     ${formatReturn(performance.spyReturn)}`,
    `  account excess vs SPY:  ${formatReturn(performance.brokerAccountExcessReturn)}`,
    `  SPY baseline source:    ${performance.spyBaseline?.source ?? performance.spyBaselineSource ?? 'unavailable'}`,
    `  SPY baseline alignment: target=${performance.spyBaseline?.targetAt ?? performance.spyBaselineTargetAt ?? 'unavailable'} ` +
      `priceAt=${performance.spyBaseline?.at ?? performance.spyBaselineAt ?? 'unavailable'} ` +
      `status=${performance.spyBaseline?.alignmentStatus ?? performance.spyBaselineAlignmentStatus ?? 'unavailable'}`,
    `  SPY current source:     ${performance.spyCurrent?.source ?? performance.spyCurrentSource ?? 'unavailable'}`,
    `  SPY current alignment:  target=${performance.spyCurrent?.targetAt ?? performance.spyCurrentTargetAt ?? 'unavailable'} ` +
      `priceAt=${performance.spyCurrent?.at ?? performance.spyCurrentAt ?? 'unavailable'} ` +
      `status=${performance.spyCurrent?.alignmentStatus ?? performance.spyCurrentAlignmentStatus ?? 'unavailable'}`,
    '  note: broker-wide equity may include manual Alpaca activity; owned exposure counts only ExaltedFable-recorded orders.',
  );
  if (performance.spyUnavailableReason) {
    lines.push(`  SPY unavailable reason: ${performance.spyUnavailableReason}`);
  }
  const warnings = brokerTruth.warnings ?? performance.warnings ?? [];
  if (warnings.length > 0) {
    lines.push('  data-quality warnings:');
    for (const warning of warnings.slice(0, LIST_CAP)) lines.push(`    ${warning}`);
  }
  return lines;
}

function pctOrUnavailable(value) {
  if (value === null || value === undefined || value === '') return 'unavailable';
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : 'unavailable';
}

function equitySizingSection(data = {}) {
  const sizing = data.sizing ?? {};
  const lines = ['- Equity sizing decisions (PAPER equities only) -'];
  if ((sizing.decisions ?? 0) === 0) {
    lines.push('  No learned equity sizing decisions recorded in this window.');
    return lines;
  }
  const modes = sizing.modeCounts ?? {};
  lines.push(
    `  decisions:             ${sizing.decisions}`,
    `  cold/evidence/abstain: ${modes.cold_start ?? 0} / ${modes.evidence_weighted ?? 0} / ${modes.abstain ?? 0}`,
    `  manual --qty override: ${sizing.manualOverrideCount ?? 0}`,
  );
  for (const s of sizing.samples ?? []) {
    const approvedWeight = s.approvedTargetWeight ?? (
      s.approvedNotional !== null && s.approvedNotional !== undefined &&
      s.accountEquity !== null && s.accountEquity !== undefined && Number(s.accountEquity) > 0
        ? Number(s.approvedNotional) / Number(s.accountEquity)
        : null
    );
    lines.push(
      `  ${s.ticker} ${s.side} ${s.manualOverride ? 'manual_override' : s.mode} ` +
        `evidence=${s.evidenceCount ?? 0}/${s.evidenceQuality ?? 'unknown'} ` +
        `requested=${s.requestedQuantity ?? 0} (${moneyOrUnavailable(s.requestedNotional)}, ${pctOrUnavailable(s.requestedTargetWeight)}) ` +
        `approved=${s.approvedQuantity ?? 0} (${moneyOrUnavailable(s.approvedNotional)}, ${pctOrUnavailable(approvedWeight)}) ` +
        `reason=${s.riskReason ?? s.explanation ?? 'unavailable'}`
    );
    const caps = s.effectiveRiskCaps ?? {};
    const orderCap = caps.orderCap ?? null;
    if (orderCap) {
      lines.push(
        `    effective order cap: source=${orderCap.source ?? 'unknown'} value=${moneyOrUnavailable(orderCap.value)} ` +
        `learnedPct=${moneyOrUnavailable(orderCap.learnedPercentCap)} explicitDollar=${moneyOrUnavailable(orderCap.explicitDollarCap)}`
      );
    }
    for (const cap of (caps.activeCaps ?? []).slice(0, LIST_CAP)) {
      const used = cap.used === null || cap.used === undefined ? '' : ` used=${moneyOrUnavailable(cap.used)}`;
      lines.push(
        `    cap ${cap.key}: source=${cap.source ?? 'unknown'} value=${moneyOrUnavailable(cap.value)}${used} ` +
        `remaining=${moneyOrUnavailable(cap.remainingNotional)} allows=${cap.allowedQuantity ?? 'n/a'} ` +
        `clamp=${cap.clamped ? 'yes' : 'no'}`
      );
    }
    if ((caps.clampReasons ?? []).length > 0) {
      for (const reason of caps.clampReasons.slice(0, LIST_CAP)) lines.push(`    clamp reason: ${reason}`);
    }
  }
  if ((sizing.warnings ?? []).length > 0) {
    lines.push('  sizing warnings:');
    for (const warning of sizing.warnings.slice(0, LIST_CAP)) lines.push(`    ${warning}`);
  }
  return lines;
}

/**
 * Build the sanitized EOD report as printable lines. Includes the required
 * narrative sections (what / why / went well / went poorly / mistakes-lessons /
 * next-day ideas) derived ONLY from the counts above — no model calls, no free
 * text beyond our own rejection-reason strings.
 */
export function buildEodReport(data, { day = null } = {}) {
  const label = day ?? data.day ?? 'all-time';
  const session = data.session ?? {};
  const dataQuality = data.dataQuality ?? assessEodDataQuality(data);
  const fmtMap = (m) => {
    const entries = Object.entries(m ?? {});
    return entries.length === 0
      ? '(none)'
      : entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(' ');
  };
  const lines = [
    `ExaltedFable — End-of-Day PAPER report (${label})`,
    'PAPER trading only. Live trading disabled.',
    '',
  ];

  if (data.proposals === 0 && (session.cycles ?? 0) === 0 && (data.sizing?.decisions ?? 0) === 0) {
    lines.push(
      'No paper-trading records for this day yet.',
      'This report still proves Discord delivery; once the paper loop runs and',
      'writes paper_trades / rejected_trades, the full narrative appears here.',
    );
    lines.push('', ...brokerTruthSection(data));
    lines.push('', ...equitySizingSection(data));
    return lines;
  }

  lines.push(
    '— Figures —',
    `  session cycles:                  ${session.cycles ?? 0}`,
    `  fresh news inserted:             ${session.freshNewsCount ?? 0}`,
    `  classifications stored:          ${session.classificationCount ?? 0}`,
    `  classification outcomes:         ${fmtMap(session.classificationStatus)}`,
    `  skipped reasons:                 ${fmtMap(session.skippedReasons)}`,
    `  proposals (orders + rejections): ${data.proposals}`,
    `  orders submitted:                ${data.ordersSubmitted}`,
    `  broker-confirmed fills:          ${data.brokerTruth?.performance?.broker?.orders?.filled ?? 'unavailable'}`,
    `  order statuses:                  ${fmtMap(data.orderStatus)}`,
    `  local fills (legacy/approx):      ${data.fills}`,
    `  equity long / short:             ${data.longCount} / ${data.shortCount}`,
    `  rejected:                        ${data.rejectedCount}`,
    `  realized P&L (local approx, USD): ${data.realizedPnl}`,
    `  broker-confirmed owned P&L:      ${moneyOrUnavailable(data.brokerTruth?.exposure?.realizedPnlUsd)}`,
    `  unrealized P&L (if available):   ${data.unrealizedPnl ?? 'unavailable'}`,
    `  owned exposure (broker truth):    ${moneyOrUnavailable(data.brokerTruth?.exposure?.grossExposure)}`,
    `  broker account return:           ${formatReturn(data.brokerTruth?.performance?.brokerAccountReturn)}`,
    `  ExaltedFable-owned return:       ${data.brokerTruth?.performance?.botReturnUnavailableReason ?? 'unavailable'}`,
    `  SPY session return:              ${formatReturn(data.brokerTruth?.performance?.spyReturn)}`,
    `  broker account excess vs SPY:    ${formatReturn(data.brokerTruth?.performance?.brokerAccountExcessReturn)}`,
    `  equity sizing decisions:         ${data.sizing?.decisions ?? 0}`,
    `  sizing cold/evidence/abstain:    ${data.sizing?.coldStartCount ?? 0} / ${data.sizing?.evidenceWeightedCount ?? 0} / ${data.sizing?.abstainCount ?? 0}`,
    `  kill switch:                     ${data.riskState?.kill_switch_active === 1
      ? `ACTIVE — ${data.riskState.kill_switch_reason ?? 'no reason recorded'}`
      : 'inactive'}`,
    `  shorts/margin usage:             ${session.shortsUsed ?? 0} / ${session.marginUsed ?? 0}`,
    `  model requests/tokens:           ${session.modelRequestCount ?? 0} request(s); token usage unavailable`,
    `  data quality:                    ${dataQuality.status}`,
    '',
    '— Data-quality warnings —',
  );
  if (dataQuality.warnings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const warning of dataQuality.warnings) lines.push(`  ${warning}`);
  }
  lines.push(
    '',
    '— Rejections (most common) —',
  );
  if (data.rejectionReasons.length === 0) {
    lines.push('  (none)');
  } else {
    for (const r of data.rejectionReasons.slice(0, LIST_CAP)) lines.push(`  ${r.n}x  ${r.reason}`);
  }

  // Narrative — templated from the figures, deliberately conservative.
  const didNothingButRefuse = data.ordersSubmitted === 0;
  lines.push(
    '',
    '— What the bot did —',
    didNothingButRefuse
      ? `  Placed no paper orders; refused ${data.rejectedCount} proposal(s).`
      : `  Submitted ${data.ordersSubmitted} paper order(s) (${data.longCount} long, ` +
        `${data.shortCount} short) and refused ${data.rejectedCount}.`,
    '',
    '— Why it did it —',
    '  Acted only on real-model up-signals that cleared the conservative',
    '  confidence/impact/sentiment gates; everything else was refused by design.',
    '',
    '— What went well —',
    didNothingButRefuse
      ? '  The safety gates held — no marginal signal was traded.'
      : data.realizedPnl >= 0
        ? `  Net realized P&L is non-negative (${data.realizedPnl}); the gates let through up-signals.`
        : '  Orders reached the paper account and were logged with full provenance.',
    '',
    '— What went poorly —',
    didNothingButRefuse
      ? '  No paper order was submitted; review skipped/rejected reasons and data-quality warnings.'
      : data.realizedPnl < 0
        ? `  Net realized P&L is negative (${data.realizedPnl}); review the entries below.`
        : '  Nothing notable.',
    '',
    '— Mistakes / lessons —',
    data.rejectionReasons.length > 0
      ? `  Most common refusal: "${data.rejectionReasons[0].reason}" (x${data.rejectionReasons[0].n}) ` +
        '— check whether the gate matches the live signal distribution.'
      : '  No recurring refusal pattern to learn from yet.',
    '',
    '— Ideas for next trading day —',
    `  Re-run during market hours; ${data.bestTicker ? `watch ${data.bestTicker}; ` : ''}` +
      'consider tightening/loosening thresholds per the refusal pattern (manually).',
  );
  if ((data.openPositions ?? []).length > 0) {
    lines.push('', '— Open positions / exposure —');
    for (const p of data.openPositions.slice(0, LIST_CAP)) {
      lines.push(`  ${p.ticker} ${p.side} qty=${p.qty} approxExposure=${p.exposure}`);
    }
  }
  lines.push('', ...brokerTruthSection(data));
  lines.push('', ...equitySizingSection(data));
  return lines;
}

/**
 * Core EOD logic, dependency-injected so tests run fully offline. Builds the
 * report and sends it ONLY when asked AND a Discord client is supplied. A
 * requested send with no client is a clear, safe failure (never a silent skip).
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string|null} [opts.day]
 * @param {number|null} [opts.sessionId]
 * @param {boolean} [opts.send]         send the full report
 * @param {boolean} [opts.testMessage]  send EOD_TEST_MESSAGE instead of the report
 * @param {object|null} [opts.discordClient]  required when send/testMessage
 */
export async function runEodReport(
  db,
  {
    day = null, send = false, testMessage = false, discordClient = null,
    sessionId = null, sessionStats = null,
  } = {}
) {
  const data = collectEodData(db, { day, sessionId });
  if (sessionStats) {
    data.session = { ...data.session, ...sessionStats };
  }
  const dataQuality = assessEodDataQuality(data);
  data.dataQuality = dataQuality;
  const lines = buildEodReport(data, { day });
  const content = lines.join('\n');
  const result = {
    day, data, lines, content, sent: false,
    dataQuality,
  };

  if (send || testMessage) {
    if (!discordClient) {
      throw new Error(
        'sendPaperEodReport: Discord not configured — set DISCORD_WEBHOOK_URL to send, ' +
          'or use --dry-run to preview locally.'
      );
    }
    await discordClient.send({ content: testMessage ? EOD_TEST_MESSAGE : content });
    result.sent = true;
  }
  return result;
}

async function main() {
  const { day, sessionId, send, testMessage } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const wantSend = send || testMessage;

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db); // idempotent; ensures paper_trades / rejected_trades exist

    // Build the Discord client only for an explicit send, and only with a
    // configured webhook. Missing webhook fails clearly (never a silent skip).
    let discordClient = null;
    if (wantSend) {
      if (!config.discord.webhookUrl) {
        console.error(
          'EOD report NOT SENT: Discord is not configured.\n' +
            'Set DISCORD_WEBHOOK_URL in your local .env (see .env.example), or run\n' +
            'with --dry-run to preview the report locally.'
        );
        process.exitCode = 1;
        return;
      }
      discordClient = createDiscordWebhookClient(config);
    }

    const result = await runEodReport(db, {
      day, sessionId, send, testMessage, discordClient,
    });
    for (const line of result.lines) console.log(line);
    if (result.sent) {
      console.log(testMessage ? 'Discord test message SENT.' : 'EOD report SENT to Discord.');
    } else {
      console.log('EOD report DRY RUN (nothing sent; pass --send-discord to deliver).');
    }
  } catch (err) {
    // Client errors are sanitized at their origin; print the message only.
    console.error(`EOD report FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
