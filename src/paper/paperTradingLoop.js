// src/paper/paperTradingLoop.js — Market-hours PAPER loop core (Phase 5).
//
// PAPER-only. The loop owns ONLY timing + market-hours gating + sanitized
// heartbeats; it calls an INJECTED `runOnce` (the one-shot paper logic) so trade
// logic is never duplicated, and injects clock/sleep/market-hours/stop so tests
// run with no real timers and no network. Dry-run vs execute is decided by the
// one-shot it calls — the loop never sends orders itself.

/** Safety floor: never poll faster than this (avoids hammering the API). */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440; // one day
export const DEFAULT_INTERVAL_MINUTES = 15;
export const OFF_HOURS_CHECKPOINT_MS = 6 * 60 * 60 * 1000;

/** null means continuous until Ctrl+C/shouldStop. */
export const DEFAULT_MAX_ITERATIONS = null;
export const MAX_ITERATIONS_CAP = 500;

/** Clamp --interval-minutes to [MIN, MAX]; junk -> default. */
export function clampIntervalMinutes(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isInteger(v) || v <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(Math.max(v, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
}

/** Clamp explicit --max-iterations to [1, MAX_ITERATIONS_CAP]; unset -> continuous. */
export function clampMaxIterations(n) {
  if (n === null || n === undefined || n === '') return DEFAULT_MAX_ITERATIONS;
  const v = Number.parseInt(n, 10);
  if (!Number.isInteger(v) || v <= 0) return DEFAULT_MAX_ITERATIONS;
  return Math.min(v, MAX_ITERATIONS_CAP);
}

function maxIterationsLabel(maxIterations) {
  return maxIterations === null || maxIterations === undefined ? 'continuous' : String(maxIterations);
}

function validMs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOrUnknown(ms) {
  const n = validMs(ms);
  return n === null ? 'unknown' : new Date(n).toISOString();
}

export function computeClosedSleepMs({ nowMs, nextWakeMs, checkpointMs = OFF_HOURS_CHECKPOINT_MS } = {}) {
  const now = validMs(nowMs) ?? Date.now();
  const next = validMs(nextWakeMs);
  if (next !== null && next > now) return next - now;
  return checkpointMs;
}

/**
 * Resolve market session state. Alpaca clock is preferred because it includes
 * holidays/early closes via next_open/next_close. When unavailable, the caller
 * gets an explicit fallback approximation status and a checkpoint wake.
 */
export async function resolveMarketSession({
  nowMs = Date.now(),
  getClock = null,
  fallbackIsMarketOpen,
  fallbackMarketStatusLabel,
} = {}) {
  if (typeof getClock === 'function') {
    try {
      const clock = await getClock();
      if (clock && typeof clock.isOpen === 'boolean') {
        const clockNow = validMs(Date.parse(clock.timestamp)) ?? nowMs;
        const nextOpenMs = validMs(Date.parse(clock.nextOpen));
        const nextCloseMs = validMs(Date.parse(clock.nextClose));
        return {
          source: 'alpaca_clock',
          isOpen: clock.isOpen,
          status: clock.isOpen ? 'open' : 'closed',
          nowMs: clockNow,
          nextOpenMs,
          nextCloseMs,
          nextWakeMs: clock.isOpen ? nextCloseMs : nextOpenMs,
          reason: clock.isOpen ? 'market open per Alpaca clock' : 'market closed per Alpaca clock',
        };
      }
    } catch {
      // Fall through to the explicit local approximation.
    }
  }

  const open = typeof fallbackIsMarketOpen === 'function' ? fallbackIsMarketOpen(nowMs) : false;
  const status =
    typeof fallbackMarketStatusLabel === 'function'
      ? fallbackMarketStatusLabel(nowMs)
      : open ? 'open' : 'closed';
  return {
    source: 'fallback_approximation',
    isOpen: open,
    status,
    nowMs,
    nextOpenMs: null,
    nextCloseMs: null,
    nextWakeMs: open ? nowMs + DEFAULT_INTERVAL_MINUTES * 60_000 : nowMs + OFF_HOURS_CHECKPOINT_MS,
    reason: open
      ? 'market open by local Mon-Fri regular-hours approximation'
      : 'market closed by local approximation; Alpaca clock unavailable',
  };
}

/** One sanitized heartbeat line. No secrets/payloads can appear here. */
export function buildHeartbeat({
  iteration, maxIterations, nowMs, marketStatus, symbols = [], executePaper = false, summary = '',
  nextWakeMs = null,
} = {}) {
  const ts = new Date(Number(nowMs) || Date.now()).toISOString();
  const mode = executePaper ? 'EXECUTE-PAPER' : 'DRY-RUN';
  return (
    `[${ts}] iter ${iteration}/${maxIterationsLabel(maxIterations)} market=${marketStatus} ` +
    `nextWake=${isoOrUnknown(nextWakeMs)} ` +
    `symbols=${(symbols ?? []).join(',') || '(none)'} mode=${mode} -> ${summary}`
  );
}

export function buildMarketTransition({ nowMs, status, source, nextWakeMs, reason } = {}) {
  return `[${new Date(Number(nowMs) || Date.now()).toISOString()}] market ${status}; ` +
    `source=${source ?? 'unknown'} nextWake=${isoOrUnknown(nextWakeMs)} reason=${reason ?? 'n/a'}`;
}

/**
 * Run the market-hours loop. All side-effecting collaborators are
 * injected, so this is fully unit-testable with fakes (no timers, no network).
 *
 * @param {object} opts
 * @param {number|null} opts.maxIterations    optional debug cap; null is continuous
 * @param {number} opts.intervalMs            sleep between iterations (already floored)
 * @param {boolean} [opts.executePaper]        for the heartbeat label only
 * @param {string[]} [opts.symbols]            for the heartbeat label only
 * @param {(ctx:{iteration:number, nowMs:number}) => Promise<string>} opts.runOnce
 *   the injected one-shot; returns a short sanitized summary string
 * @param {(ctx:{nowMs:number}) => Promise<object>} [opts.getMarketSession]
 * @param {(nowMs:number) => boolean} [opts.isMarketOpen] fallback only
 * @param {(nowMs:number) => string} [opts.marketStatusLabel] fallback only
 * @param {() => number} [opts.now]
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 * @param {(line:string) => void} [opts.onHeartbeat]
 * @param {(line:string) => void} [opts.onStateChange]
 * @param {(ctx:{nowMs:number, session:object}) => Promise<void>|void} [opts.onSessionClosed]
 * @param {() => boolean} [opts.shouldStop]    e.g. set by a SIGINT handler
 * @returns {Promise<{ iterations:number, heartbeats:string[], stopped:boolean }>}
 */
export async function runPaperLoop({
  maxIterations = DEFAULT_MAX_ITERATIONS,
  intervalMs,
  executePaper = false,
  symbols = [],
  runOnce,
  getMarketSession = null,
  isMarketOpen,
  marketStatusLabel,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onHeartbeat = () => {},
  onStateChange = () => {},
  onSessionClosed = async () => {},
  shouldStop = () => false,
} = {}) {
  const heartbeats = [];
  let stopped = false;
  let previousStatus = null;
  let i = 0;
  while (maxIterations === null || maxIterations === undefined || i < maxIterations) {
    if (shouldStop()) { stopped = true; break; }
    i += 1;
    const nowMs = now();
    const session = getMarketSession
      ? await getMarketSession({ nowMs })
      : await resolveMarketSession({
        nowMs,
        fallbackIsMarketOpen: isMarketOpen,
        fallbackMarketStatusLabel: marketStatusLabel,
      });
    const marketStatus = session.status;
    const previous = previousStatus;
    if (marketStatus !== previousStatus) {
      onStateChange(buildMarketTransition({
        nowMs,
        status: marketStatus,
        source: session.source,
        nextWakeMs: session.isOpen ? nowMs + intervalMs : session.nextWakeMs,
        reason: session.reason,
      }));
      previousStatus = marketStatus;
      if (previous === 'open' && marketStatus !== 'open') {
        try {
          await onSessionClosed({ nowMs, session });
        } catch {
          // EOD/reporting failures are observable in caller logs/status, but
          // must not terminate the market loop.
        }
      }
    }

    let summary;
    if (session.isOpen) {
      try {
        summary = await runOnce({ iteration: i, nowMs });
      } catch (err) {
        // Never leak the raw error object; runOnce/clients already sanitize.
        summary = `iteration error: ${err.message}`;
      }
    } else {
      summary = `skipped (market closed; next wake ${isoOrUnknown(session.nextWakeMs)})`;
    }

    const nextWakeMs = session.isOpen ? nowMs + intervalMs : session.nextWakeMs;
    const hb = buildHeartbeat({
      iteration: i, maxIterations, nowMs, marketStatus, symbols, executePaper, summary, nextWakeMs,
    });
    heartbeats.push(hb);
    onHeartbeat(hb);

    const finiteDone = maxIterations !== null && maxIterations !== undefined && i >= maxIterations;
    if (!finiteDone && !shouldStop()) {
      const sleepMs = session.isOpen ? intervalMs : computeClosedSleepMs({ nowMs: now(), nextWakeMs: session.nextWakeMs });
      await sleep(Math.max(0, sleepMs));
    }
  }
  return { iterations: heartbeats.length, heartbeats, stopped };
}
