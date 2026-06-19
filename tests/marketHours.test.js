// tests/marketHours.test.js — Pure market-hours tests; no network, no DB.
// All times are constructed in Eastern terms via known UTC instants.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarketOpen, isWeekend, marketStatusLabel } from '../src/paper/marketHours.js';

// 2026-06-17 is a Wednesday. EDT = UTC-4 in June.
const WED_1000_ET = Date.parse('2026-06-17T14:00:00.000Z'); // 10:00 ET
const WED_0900_ET = Date.parse('2026-06-17T13:00:00.000Z'); // 09:00 ET (pre-market)
const WED_0930_ET = Date.parse('2026-06-17T13:30:00.000Z'); // 09:30 ET (open boundary)
const WED_1600_ET = Date.parse('2026-06-17T20:00:00.000Z'); // 16:00 ET (close boundary)
const WED_1630_ET = Date.parse('2026-06-17T20:30:00.000Z'); // 16:30 ET (after hours)
const SAT_1200_ET = Date.parse('2026-06-20T16:00:00.000Z'); // Saturday noon ET

test('open during regular session', () => {
  assert.equal(isMarketOpen(WED_1000_ET), true);
  assert.equal(marketStatusLabel(WED_1000_ET), 'open');
});

test('the 09:30 open boundary is open; 16:00 close boundary is closed', () => {
  assert.equal(isMarketOpen(WED_0930_ET), true);
  assert.equal(isMarketOpen(WED_1600_ET), false); // [09:30, 16:00)
});

test('pre-market and after-hours are closed', () => {
  assert.equal(isMarketOpen(WED_0900_ET), false);
  assert.equal(isMarketOpen(WED_1630_ET), false);
  assert.equal(marketStatusLabel(WED_0900_ET), 'closed');
});

test('weekends are closed and flagged', () => {
  assert.equal(isWeekend(SAT_1200_ET), true);
  assert.equal(isMarketOpen(SAT_1200_ET), false);
  assert.equal(marketStatusLabel(SAT_1200_ET), 'closed_weekend');
});
