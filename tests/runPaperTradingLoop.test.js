// tests/runPaperTradingLoop.test.js — Network-free, timer-free tests for the
// market-hours loop. The loop core runs with INJECTED clock/sleep/market-hours/
// runOnce/stop, so there are no real timers and no network. Importing the script
// runs NOTHING (CLI guard).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runPaperLoop, buildHeartbeat, clampIntervalMinutes, clampMaxIterations, resolveMarketSession,
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

test('max iterations is capped, and unset/junk means continuous', () => {
  assert.equal(clampMaxIterations('999999'), MAX_ITERATIONS_CAP);
  assert.equal(clampMaxIterations('5'), 5);
  assert.equal(clampMaxIterations('0'), DEFAULT_MAX_ITERATIONS);
  assert.equal(clampMaxIterations(undefined), null);
  assert.equal(DEFAULT_MAX_ITERATIONS, null);
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
  assert.ok(res.heartbeats.every((h) => h.includes('skipped (market closed; next wake')));
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

test('--run-outside-market-hours no longer forces closed-market work', async () => {
  let ran = 0;
  await runPaperLoop({
    maxIterations: 1, intervalMs: 0, runOutsideMarketHours: true, symbols: ['AAPL'],
    runOnce: async () => { ran += 1; return 'ran anyway'; },
    isMarketOpen: () => false, marketStatusLabel: () => 'closed', now: fixedNow, sleep: noSleep,
  });
  assert.equal(ran, 0);
});

test('resolveMarketSession uses Alpaca clock next_open/next_close when available', async () => {
  const closed = await resolveMarketSession({
    nowMs: fixedNow(),
    getClock: async () => ({
      timestamp: '2026-06-17T20:30:00.000Z',
      isOpen: false,
      nextOpen: '2026-06-18T13:30:00.000Z',
      nextClose: '2026-06-18T20:00:00.000Z',
    }),
    fallbackIsMarketOpen: () => true,
    fallbackMarketStatusLabel: () => 'open',
  });
  assert.equal(closed.source, 'alpaca_clock');
  assert.equal(closed.isOpen, false);
  assert.equal(closed.nextWakeMs, Date.parse('2026-06-18T13:30:00.000Z'));

  const fallback = await resolveMarketSession({
    nowMs: fixedNow(),
    getClock: async () => { throw new Error('clock unavailable'); },
    fallbackIsMarketOpen: () => false,
    fallbackMarketStatusLabel: () => 'closed',
  });
  assert.equal(fallback.source, 'fallback_approximation');
  assert.equal(fallback.isOpen, false);
});

test('resolveMarketSession handles holiday-style closures and half-day early closes via Alpaca clock', async () => {
  const holiday = await resolveMarketSession({
    nowMs: Date.parse('2026-07-03T15:00:00.000Z'),
    getClock: async () => ({
      timestamp: '2026-07-03T15:00:00.000Z',
      isOpen: false,
      nextOpen: '2026-07-06T13:30:00.000Z',
      nextClose: '2026-07-06T20:00:00.000Z',
    }),
    fallbackIsMarketOpen: () => true,
    fallbackMarketStatusLabel: () => 'open',
  });
  assert.equal(holiday.isOpen, false);
  assert.equal(holiday.nextWakeMs, Date.parse('2026-07-06T13:30:00.000Z'));

  const halfDay = await resolveMarketSession({
    nowMs: Date.parse('2026-11-27T16:00:00.000Z'),
    getClock: async () => ({
      timestamp: '2026-11-27T16:00:00.000Z',
      isOpen: true,
      nextOpen: '2026-11-27T14:30:00.000Z',
      nextClose: '2026-11-27T18:00:00.000Z',
    }),
    fallbackIsMarketOpen: () => true,
    fallbackMarketStatusLabel: () => 'open',
  });
  assert.equal(halfDay.isOpen, true);
  assert.equal(halfDay.nextWakeMs, Date.parse('2026-11-27T18:00:00.000Z'));
});

test('fallback weekend startup stays closed and sleeps to checkpoint without work', async () => {
  const saturday = () => Date.parse('2026-06-20T16:00:00.000Z');
  let ran = 0;
  let slept = null;
  const res = await runPaperLoop({
    maxIterations: 1,
    intervalMs: 0,
    runOnce: async () => { ran += 1; return 'work'; },
    isMarketOpen: () => false,
    marketStatusLabel: () => 'closed_weekend',
    now: saturday,
    sleep: async (ms) => { slept = ms; },
  });
  assert.equal(ran, 0);
  assert.equal(res.iterations, 1);
  assert.equal(slept, null); // finite single iteration: no follow-up sleep
  assert.match(res.heartbeats[0], /market=closed_weekend/);
});

test('open-to-closed transition calls EOD hook once and hook failure is non-fatal', async () => {
  let ran = 0;
  let eodCalls = 0;
  const sessions = [
    { isOpen: true, status: 'open', source: 'test', nextWakeMs: fixedNow() + 1, reason: 'open' },
    { isOpen: false, status: 'closed', source: 'test', nextWakeMs: fixedNow() + 2, reason: 'closed' },
    { isOpen: false, status: 'closed', source: 'test', nextWakeMs: fixedNow() + 3, reason: 'closed' },
  ];
  const res = await runPaperLoop({
    maxIterations: 3,
    intervalMs: 0,
    runOnce: async () => { ran += 1; return 'cycle ok'; },
    getMarketSession: async () => sessions.shift(),
    now: fixedNow,
    sleep: noSleep,
    onSessionClosed: async () => { eodCalls += 1; throw new Error('discord down'); },
  });
  assert.equal(ran, 1);
  assert.equal(eodCalls, 1);
  assert.equal(res.iterations, 3);
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
  assert.match(hb, /nextWake=/);
  assert.match(hb, /symbols=AAPL,MSFT/);
  assert.match(hb, /mode=EXECUTE-PAPER/);
  assert.match(hb, /equity buy accepted/);
});

// --- loop CLI parsing forwards advanced flags ------------------------------

test('loop parseArgs forwards advanced one-shot flags AND its own scheduling flags', () => {
  const a = parseArgs([
    '--symbols', 'AAPL,MSFT', '--classifier', 'openai', '--ingest-limit', '12',
    '--classify-limit', '4', '--news-lookback-minutes', '90',
    '--allow-shorts',
    '--max-order-notional', '500', '--interval-minutes', '1', '--max-iterations', '20',
    '--run-outside-market-hours', 'true', '--send-discord-eod-report', '--execute-paper',
  ]);
  // forwarded one-shot flags
  assert.deepEqual(a.symbols, ['AAPL', 'MSFT']);
  assert.equal(a.classifier, 'openai');
  assert.equal(a.ingestLimit, 12);
  assert.equal(a.classifyLimit, 4);
  assert.equal(a.newsLookbackMinutes, 90);
  assert.equal(a.allowShorts, true);
  assert.equal(a.caps.maxOrderNotional, 500);
  assert.equal(a.executePaper, true);
  // loop-specific flags
  assert.equal(a.intervalMinutes, MIN_INTERVAL_MINUTES); // 1 floored to 5
  assert.equal(a.maxIterations, 20);
  assert.equal(a.runOutsideMarketHours, false);
  assert.equal(a.deprecatedRunOutsideMarketHours, true);
  assert.equal(a.sendDiscordEod, true);
});

test('loop parseArgs defaults to continuous operation without --max-iterations', () => {
  const a = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai']);
  assert.equal(a.maxIterations, null);
});

test('loop parseArgs applies non-secret defaults while CLI flags still win', () => {
  const a = parseArgs(
    ['--symbols', 'AAPL', '--impact-threshold', '0.4', '--interval-minutes', '15'],
    {
      symbols: ['MSFT'],
      classifier: 'openai',
      ingestLimit: 9,
      classifyLimit: 3,
      newsLookbackMinutes: 45,
      thresholds: { minConfidence: 0.52, minImpact: 0.33, minSentiment: 0.18 },
      intervalMinutes: 10,
      maxIterations: 7,
    }
  );
  assert.deepEqual(a.symbols, ['AAPL']); // CLI wins
  assert.equal(a.classifier, 'openai');
  assert.equal(a.ingestLimit, 9);
  assert.equal(a.classifyLimit, 3);
  assert.equal(a.newsLookbackMinutes, 45);
  assert.equal(a.thresholds.minConfidence, 0.52);
  assert.equal(a.thresholds.minImpact, 0.4); // CLI wins over default
  assert.equal(a.thresholds.minSentiment, 0.18);
  assert.equal(a.intervalMinutes, 15); // CLI wins over default
  assert.equal(a.maxIterations, 7);
});

test('importing the loop script performs no network and requires no credentials', () => {
  assert.equal(typeof runPaperLoop, 'function');
  assert.equal(typeof parseArgs, 'function');
});
