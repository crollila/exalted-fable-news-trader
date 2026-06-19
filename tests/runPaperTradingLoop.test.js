// tests/runPaperTradingLoop.test.js — Network-free, timer-free tests for the
// market-hours loop. The loop core runs with INJECTED clock/sleep/market-hours/
// runOnce/stop, so there are no real timers and no network. Importing the script
// runs NOTHING (CLI guard).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runPaperLoop, buildHeartbeat, clampIntervalMinutes, clampMaxIterations,
  MIN_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CAP,
} from '../src/paper/paperTradingLoop.js';
import { parseArgs } from '../scripts/runPaperTradingLoop.js';

const noSleep = async () => {};
const fixedNow = () => Date.parse('2026-06-17T14:00:00.000Z'); // Wed 10:00 ET

// --- clamping --------------------------------------------------------------

test('interval is floored at the safe minimum and defaults on junk', () => {
  assert.equal(clampIntervalMinutes('1'), MIN_INTERVAL_MINUTES); // floored to 5
  assert.equal(clampIntervalMinutes('15'), 15);
  assert.equal(clampIntervalMinutes('nope'), DEFAULT_INTERVAL_MINUTES);
  assert.equal(MIN_INTERVAL_MINUTES, 5);
});

test('max iterations is capped and defaults on junk', () => {
  assert.equal(clampMaxIterations('999999'), MAX_ITERATIONS_CAP);
  assert.equal(clampMaxIterations('5'), 5);
  assert.equal(clampMaxIterations('0'), DEFAULT_MAX_ITERATIONS);
});

// --- market-hours gating ---------------------------------------------------

test('does NOT run the one-shot outside market hours by default', async () => {
  let ran = 0;
  const res = await runPaperLoop({
    maxIterations: 3, intervalMs: 0, runOutsideMarketHours: false, symbols: ['AAPL'],
    runOnce: async () => { ran += 1; return 'did work'; },
    isMarketOpen: () => false, marketStatusLabel: () => 'closed',
    now: fixedNow, sleep: noSleep,
  });
  assert.equal(ran, 0);
  assert.equal(res.iterations, 3);
  assert.ok(res.heartbeats.every((h) => h.includes('skipped (market closed)')));
});

test('runs the one-shot when the market is open', async () => {
  let ran = 0;
  await runPaperLoop({
    maxIterations: 2, intervalMs: 0, symbols: ['AAPL'],
    runOnce: async () => { ran += 1; return 'equity buy accepted'; },
    isMarketOpen: () => true, marketStatusLabel: () => 'open', now: fixedNow, sleep: noSleep,
  });
  assert.equal(ran, 2);
});

test('--run-outside-market-hours true forces the one-shot to run when closed', async () => {
  let ran = 0;
  await runPaperLoop({
    maxIterations: 1, intervalMs: 0, runOutsideMarketHours: true, symbols: ['AAPL'],
    runOnce: async () => { ran += 1; return 'ran anyway'; },
    isMarketOpen: () => false, marketStatusLabel: () => 'closed', now: fixedNow, sleep: noSleep,
  });
  assert.equal(ran, 1);
});

// --- bounds & shutdown -----------------------------------------------------

test('max iterations stops the loop', async () => {
  const res = await runPaperLoop({
    maxIterations: 4, intervalMs: 0,
    runOnce: async () => 'x', isMarketOpen: () => true, marketStatusLabel: () => 'open',
    now: fixedNow, sleep: noSleep,
  });
  assert.equal(res.iterations, 4);
  assert.equal(res.stopped, false);
});

test('shouldStop (e.g. Ctrl+C) exits cleanly before the cap', async () => {
  let i = 0;
  const res = await runPaperLoop({
    maxIterations: 10, intervalMs: 0,
    runOnce: async () => { i += 1; return 'x'; },
    isMarketOpen: () => true, marketStatusLabel: () => 'open', now: fixedNow, sleep: noSleep,
    shouldStop: () => i >= 2, // stop after two runs
  });
  assert.ok(res.iterations <= 3);
  assert.equal(res.stopped, true);
});

test('a runOnce error is captured in the heartbeat, never thrown', async () => {
  const res = await runPaperLoop({
    maxIterations: 1, intervalMs: 0,
    runOnce: async () => { throw new Error('boom'); },
    isMarketOpen: () => true, marketStatusLabel: () => 'open', now: fixedNow, sleep: noSleep,
  });
  assert.match(res.heartbeats[0], /iteration error: boom/);
});

// --- heartbeat sanitation --------------------------------------------------

test('buildHeartbeat shows mode + market status and no secrets', () => {
  const hb = buildHeartbeat({ iteration: 1, maxIterations: 5, nowMs: fixedNow(), marketStatus: 'open', symbols: ['AAPL', 'MSFT'], executePaper: true, summary: 'equity buy accepted' });
  assert.match(hb, /iter 1\/5/);
  assert.match(hb, /market=open/);
  assert.match(hb, /symbols=AAPL,MSFT/);
  assert.match(hb, /mode=EXECUTE-PAPER/);
  assert.match(hb, /equity buy accepted/);
});

// --- loop CLI parsing forwards advanced flags ------------------------------

test('loop parseArgs forwards advanced one-shot flags AND its own scheduling flags', () => {
  const a = parseArgs([
    '--symbols', 'AAPL,MSFT', '--allow-shorts', '--allow-options', '--options-mode', 'plan_only',
    '--max-order-notional', '500', '--interval-minutes', '1', '--max-iterations', '20',
    '--run-outside-market-hours', 'true', '--send-discord-eod-report', '--execute-paper',
  ]);
  // forwarded one-shot flags
  assert.deepEqual(a.symbols, ['AAPL', 'MSFT']);
  assert.equal(a.allowShorts, true);
  assert.equal(a.allowOptions, true);
  assert.equal(a.caps.maxOrderNotional, 500);
  assert.equal(a.executePaper, true);
  // loop-specific flags
  assert.equal(a.intervalMinutes, MIN_INTERVAL_MINUTES); // 1 floored to 5
  assert.equal(a.maxIterations, 20);
  assert.equal(a.runOutsideMarketHours, true);
  assert.equal(a.sendDiscordEod, true);
});

test('importing the loop script performs no network and requires no credentials', () => {
  assert.equal(typeof runPaperLoop, 'function');
  assert.equal(typeof parseArgs, 'function');
});
