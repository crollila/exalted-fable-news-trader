// tests/accountCapabilities.test.js — Pure-function tests; no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCapabilities, grossExposure, symbolExposure, findOptionPosition,
  summarizeCapabilities, MIN_SHORT_EQUITY_USD,
} from '../src/paper/accountCapabilities.js';

const margin = (over = {}) => ({
  status: 'ACTIVE', equity: 30000, cash: 10000, buyingPower: 60000, multiplier: 2,
  patternDayTrader: false, tradingBlocked: false, accountBlocked: false,
  optionsTradingLevel: 2, optionsApprovedLevel: 2, ...over,
});

test('a healthy margin account is short- and options-eligible', () => {
  const cap = deriveCapabilities(margin());
  assert.equal(cap.available, true);
  assert.equal(cap.blocked, false);
  assert.equal(cap.marginEligible, true);
  assert.equal(cap.shortEligible, true);
  assert.equal(cap.optionsEligible, true);
  assert.equal(cap.optionsLevel, 2);
});

test('a cash account (multiplier 1) is not short/margin eligible', () => {
  const cap = deriveCapabilities(margin({ multiplier: 1 }));
  assert.equal(cap.marginEligible, false);
  assert.equal(cap.shortEligible, false);
});

test('a margin account below the equity minimum cannot short', () => {
  const cap = deriveCapabilities(margin({ equity: MIN_SHORT_EQUITY_USD - 1 }));
  assert.equal(cap.marginEligible, true);
  assert.equal(cap.shortEligible, false);
});

test('blocked accounts fail closed', () => {
  assert.equal(deriveCapabilities(margin({ tradingBlocked: true })).blocked, true);
  assert.equal(deriveCapabilities(margin({ accountBlocked: true })).shortEligible, false);
});

test('unknown options level => options not eligible (fail closed)', () => {
  const cap = deriveCapabilities(margin({ optionsTradingLevel: null, optionsApprovedLevel: null }));
  assert.equal(cap.optionsEligible, false);
  assert.equal(cap.optionsLevel, null);
});

test('a null account yields an unavailable, blocked capability set', () => {
  const cap = deriveCapabilities(null);
  assert.equal(cap.available, false);
  assert.equal(cap.blocked, true);
  assert.equal(cap.shortEligible, false);
  assert.equal(cap.optionsEligible, false);
});

test('exposure helpers sum absolute market values', () => {
  const positions = [
    { symbol: 'AAPL', marketValue: 2000, assetClass: 'us_equity' },
    { symbol: 'AAPL', marketValue: -500, assetClass: 'us_equity' },
    { symbol: 'MSFT', marketValue: 1000, assetClass: 'us_equity' },
  ];
  assert.equal(grossExposure(positions), 3500);
  assert.equal(symbolExposure(positions, 'AAPL'), 2500);
  assert.equal(symbolExposure([], 'AAPL'), 0);
});

test('findOptionPosition matches OCC option positions only', () => {
  const positions = [
    { symbol: 'AAPL260116C00150000', assetClass: 'us_option' },
    { symbol: 'AAPL', assetClass: 'us_equity' },
  ];
  assert.ok(findOptionPosition(positions, 'AAPL260116C00150000'));
  assert.equal(findOptionPosition(positions, 'AAPL'), null);
});

test('summarizeCapabilities exposes only non-secret fields', () => {
  const s = summarizeCapabilities(deriveCapabilities(margin()));
  assert.deepEqual(Object.keys(s).sort(), [
    'available', 'blocked', 'buyingPower', 'equity', 'marginEligible',
    'multiplier', 'optionsEligible', 'optionsLevel', 'shortEligible',
  ]);
});
