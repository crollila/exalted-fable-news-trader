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

/** Bounded iterations: no unbounded background run. */
export const DEFAULT_MAX_ITERATIONS = 20;
export const MAX_ITERATIONS_CAP = 500;

/** Clamp --interval-minutes to [MIN, MAX]; junk -> default. */
export function clampIntervalMinutes(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isInteger(v) || v <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(Math.max(v, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
}

/** Clamp --max-iterations to [1, MAX_ITERATIONS_CAP]; junk -> default. */
export function clampMaxIterations(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isInteger(v) || v <= 0) return DEFAULT_MAX_ITERATIONS;
  return Math.min(v, MAX_ITERATIONS_CAP);
}

/** One sanitized heartbeat line. No secrets/payloads can appear here. */
export function buildHeartbeat({
  iteration, maxIterations, nowMs, marketStatus, symbols = [], executePaper = false, summary = '',
} = {}) {
  const ts = new Date(Number(nowMs) || Date.now()).toISOString();
  const mode = executePaper ? 'EXECUTE-PAPER' : 'DRY-RUN';
  return (
    `[${ts}] iter ${iteration}/${maxIterations} market=${marketStatus} ` +
    `symbols=${(symbols ?? []).join(',') || '(none)'} mode=${mode} -> ${summary}`
  );
}

/**
 * Run the bounded market-hours loop. All side-effecting collaborators are
 * injected, so this is fully unit-testable with fakes (no timers, no network).
 *
 * @param {object} opts
 * @param {number} opts.maxIterations         hard iteration cap (already clamped)
 * @param {number} opts.intervalMs            sleep between iterations (already floored)
 * @param {boolean} [opts.runOutsideMarketHours]  default false: skip when closed
 * @param {boolean} [opts.executePaper]        for the heartbeat label only
 * @param {string[]} [opts.symbols]            for the heartbeat label only
 * @param {(ctx:{iteration:number, nowMs:number}) => Promise<string>} opts.runOnce
 *   the injected one-shot; returns a short sanitized summary string
 * @param {(nowMs:number) => boolean} opts.isMarketOpen
 * @param {(nowMs:number) => string} opts.marketStatusLabel
 * @param {() => number} [opts.now]
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 * @param {(line:string) => void} [opts.onHeartbeat]
 * @param {() => boolean} [opts.shouldStop]    e.g. set by a SIGINT handler
 * @returns {Promise<{ iterations:number, heartbeats:string[], stopped:boolean }>}
 */
export async function runPaperLoop({
  maxIterations,
  intervalMs,
  runOutsideMarketHours = false,
  executePaper = false,
  symbols = [],
  runOnce,
  isMarketOpen,
  marketStatusLabel,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onHeartbeat = () => {},
  shouldStop = () => false,
} = {}) {
  const heartbeats = [];
  let stopped = false;
  for (let i = 1; i <= maxIterations; i += 1) {
    if (shouldStop()) { stopped = true; break; }
    const nowMs = now();
    const open = isMarketOpen(nowMs);
    const marketStatus = marketStatusLabel(nowMs);

    let summary;
    if (open || runOutsideMarketHours) {
      try {
        summary = await runOnce({ iteration: i, nowMs });
      } catch (err) {
        // Never leak the raw error object; runOnce/clients already sanitize.
        summary = `iteration error: ${err.message}`;
      }
    } else {
      summary = 'skipped (market closed)';
    }

    const hb = buildHeartbeat({ iteration: i, maxIterations, nowMs, marketStatus, symbols, executePaper, summary });
    heartbeats.push(hb);
    onHeartbeat(hb);

    if (i < maxIterations && !shouldStop()) await sleep(intervalMs);
  }
  return { iterations: heartbeats.length, heartbeats, stopped };
}
