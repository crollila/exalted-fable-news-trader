// src/paper/riskState.js — Daily-loss kill switch over the risk_state table.
//
// One row per UTC trading day. When the day's broker-confirmed realized loss
// exceeds the configured cap (MAX_DAILY_LOSS_USD), the kill switch trips and
// the trade cycle refuses every new proposal for the rest of that day; a new
// trading day starts clean. The switch can also be flipped manually via
// scripts/setKillSwitch.js.
//
// Signal quality note: the trigger sums broker-confirmed realized P&L
// (paper_trades.broker_realized_pnl_usd), which is populated by broker-truth
// reconciliation — so the halt is conservative-slow (it reacts after fills are
// confirmed), never tick-instant. Unconfirmed/unrealized losses do not trip it.

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function requiredDay(day) {
  const s = String(day ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('riskState: day must be YYYY-MM-DD');
  return s;
}

/** The UTC trading day for a timestamp (ms). */
export function tradingDay(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** The risk_state row for one day, or null when none exists yet. */
export function getRiskState(db, day) {
  return db.prepare('SELECT * FROM risk_state WHERE trading_day = ?').get(requiredDay(day)) ?? null;
}

/** True when the kill switch is active for the day. */
export function isKillSwitchActive(db, day) {
  return getRiskState(db, day)?.kill_switch_active === 1;
}

/**
 * Upsert the day's risk_state row. Only the provided fields change; the
 * kill-switch flag/reason are set explicitly by trip/clear helpers.
 */
function upsertRiskState(db, day, { realizedPnlUsd, killSwitchActive, killSwitchReason } = {}) {
  const d = requiredDay(day);
  db.prepare(
    `INSERT INTO risk_state (trading_day, realized_pnl_usd, kill_switch_active, kill_switch_reason)
     VALUES (@day, COALESCE(@realizedPnlUsd, 0), COALESCE(@killSwitchActive, 0), @killSwitchReason)
     ON CONFLICT(trading_day) DO UPDATE SET
       realized_pnl_usd   = COALESCE(@realizedPnlUsd, realized_pnl_usd),
       kill_switch_active = COALESCE(@killSwitchActive, kill_switch_active),
       kill_switch_reason = COALESCE(@killSwitchReason, kill_switch_reason),
       updated_at         = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run({
    day: d,
    realizedPnlUsd: finiteOrNull(realizedPnlUsd),
    killSwitchActive: killSwitchActive === undefined ? null : killSwitchActive ? 1 : 0,
    killSwitchReason: killSwitchReason ?? null,
  });
  return getRiskState(db, d);
}

/** Trip the kill switch for the day (idempotent). Reason is mandatory. */
export function tripKillSwitch(db, { day, reason, realizedPnlUsd = null } = {}) {
  const cleanReason = String(reason ?? '').trim();
  if (!cleanReason) throw new Error('tripKillSwitch: reason is required');
  return upsertRiskState(db, day, {
    realizedPnlUsd,
    killSwitchActive: true,
    killSwitchReason: cleanReason,
  });
}

/** Clear the kill switch for the day (manual operator action only). */
export function clearKillSwitch(db, { day, reason = 'manually cleared' } = {}) {
  const d = requiredDay(day);
  db.prepare(
    `INSERT INTO risk_state (trading_day, kill_switch_active, kill_switch_reason)
     VALUES (?, 0, ?)
     ON CONFLICT(trading_day) DO UPDATE SET
       kill_switch_active = 0,
       kill_switch_reason = excluded.kill_switch_reason,
       updated_at         = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(d, String(reason));
  return getRiskState(db, d);
}

/**
 * Sum the day's broker-confirmed realized P&L over paper_trades. Rows without
 * a confirmed realized value contribute nothing (conservative: unknown != loss).
 */
export function computeRealizedDailyPnl(db, day) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(broker_realized_pnl_usd), 0) AS pnl,
              COUNT(broker_realized_pnl_usd) AS confirmed
         FROM paper_trades
        WHERE substr(created_at, 1, 10) = ?
          AND broker_realized_pnl_usd IS NOT NULL`
    )
    .get(requiredDay(day));
  return {
    realizedPnlUsd: Number(row?.pnl ?? 0),
    confirmedRows: Number(row?.confirmed ?? 0),
  };
}

/** Pure daily-loss assessment: exceeded when realized loss > cap. */
export function assessDailyLoss({ realizedPnlUsd, maxDailyLossUsd } = {}) {
  const pnl = finiteOrNull(realizedPnlUsd);
  const cap = finiteOrNull(maxDailyLossUsd);
  if (cap === null || cap <= 0) {
    return { exceeded: false, reason: 'no daily loss cap configured', realizedPnlUsd: pnl, maxDailyLossUsd: cap };
  }
  if (pnl === null) {
    return { exceeded: false, reason: 'realized P&L unavailable', realizedPnlUsd: null, maxDailyLossUsd: cap };
  }
  const exceeded = pnl <= -cap;
  return {
    exceeded,
    reason: exceeded
      ? `daily realized loss $${Math.abs(pnl).toFixed(2)} breached MAX_DAILY_LOSS_USD $${cap.toFixed(2)}`
      : `daily realized P&L $${pnl.toFixed(2)} within MAX_DAILY_LOSS_USD $${cap.toFixed(2)}`,
    realizedPnlUsd: pnl,
    maxDailyLossUsd: cap,
  };
}

/**
 * Cycle hook: recompute the day's broker-confirmed realized P&L, persist it to
 * risk_state, and trip the kill switch when the loss cap is breached. Returns
 * the assessment plus whether this call tripped the switch.
 */
export function updateDailyLossState(db, { day, maxDailyLossUsd } = {}) {
  const d = requiredDay(day);
  const { realizedPnlUsd } = computeRealizedDailyPnl(db, d);
  const assessment = assessDailyLoss({ realizedPnlUsd, maxDailyLossUsd });
  const already = isKillSwitchActive(db, d);
  if (assessment.exceeded && !already) {
    tripKillSwitch(db, { day: d, reason: assessment.reason, realizedPnlUsd });
    return { ...assessment, tripped: true, alreadyActive: false };
  }
  upsertRiskState(db, d, { realizedPnlUsd });
  return { ...assessment, tripped: false, alreadyActive: already };
}
