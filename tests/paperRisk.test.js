// tests/paperRisk.test.js — Pure margin-risk tests; no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, resolveCaps, estimateNotional, DEFAULT_CAPS } from '../src/paper/paperRisk.js';
import { deriveCapabilities } from '../src/paper/accountCapabilities.js';

const margin = (over = {}) => ({
  status: 'ACTIVE', equity: 30000, cash: 10000, buyingPower: 60000, multiplier: 2,
  tradingBlocked: false, accountBlocked: false, optionsTradingLevel: 2, ...over,
});
const cap = (a) => deriveCapabilities(a);
const longEquity = (over = {}) => ({ assetClass: 'equity', side: 'buy', ticker: 'AAPL', quantity: 1, ...over });
const shortableAsset = (over = {}) => ({ symbol: 'AAPL', tradable: true, shortable: true, easyToBorrow: true, ...over });

test('resolveCaps fills conservative defaults', () => {
  assert.deepEqual(resolveCaps({}), DEFAULT_CAPS);
  assert.equal(resolveCaps({ maxOrderNotional: 250 }).maxOrderNotional, 250);
});

test('estimateNotional: equity = price*qty, option = price*100*contracts, null when no price', () => {
  assert.equal(estimateNotional({ assetClass: 'equity', quantity: 3, referencePrice: 100 }), 300);
  assert.equal(estimateNotional({ assetClass: 'option', quantity: 2, referencePrice: 1.5 }), 300);
  assert.equal(estimateNotional({ assetClass: 'equity', quantity: 3, referencePrice: null }), null);
});

test('approves a long within all caps', () => {
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin()), account: margin(), referencePrice: 200 });
  assert.equal(r.approved, true);
  assert.equal(r.estNotional, 200);
});

test('rejects when the account is blocked', () => {
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin({ tradingBlocked: true })), account: margin({ tradingBlocked: true }), referencePrice: 100 });
  assert.equal(r.approved, false);
  assert.match(r.reason, /blocked/);
});

test('rejects a short on a non-margin account', () => {
  const acct = margin({ multiplier: 1 });
  const r = assessRisk({ proposal: longEquity({ side: 'sell' }), capabilities: cap(acct), account: acct, referencePrice: 100 });
  assert.equal(r.approved, false);
  assert.match(r.reason, /margin\/short eligible/);
});

test('rejects a short when equity is below the margin threshold', () => {
  const acct = margin({ equity: 1500 });
  const r = assessRisk({ proposal: longEquity({ side: 'sell' }), capabilities: cap(acct), account: acct, referencePrice: 100 });
  assert.equal(r.approved, false);
  assert.match(r.reason, /margin threshold|short eligible/);
});

test('rejects over --max-order-notional', () => {
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin()), account: margin(), referencePrice: 1000, caps: { maxOrderNotional: 500 } });
  assert.equal(r.approved, false);
  assert.match(r.reason, /max-order-notional/);
});

test('rejects over --max-symbol-exposure given existing positions', () => {
  const positions = [{ symbol: 'AAPL', marketValue: 900, assetClass: 'us_equity' }];
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin()), account: margin(), positions, referencePrice: 200, caps: { maxSymbolExposure: 1000 } });
  assert.equal(r.approved, false);
  assert.match(r.reason, /symbol-exposure/);
});

test('rejects over --max-gross-exposure', () => {
  const positions = [{ symbol: 'MSFT', marketValue: 4900, assetClass: 'us_equity' }];
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin()), account: margin(), positions, referencePrice: 200, caps: { maxGrossExposure: 5000 } });
  assert.equal(r.approved, false);
  assert.match(r.reason, /gross-exposure/);
});

test('rejects when the daily order cap is reached', () => {
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin()), account: margin(), referencePrice: 100, daily: { orders: 10, notional: 0 }, caps: { maxDailyPaperOrders: 10 } });
  assert.equal(r.approved, false);
  assert.match(r.reason, /daily paper order cap/);
});

test('rejects over --max-daily-paper-notional', () => {
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin()), account: margin(), referencePrice: 200, daily: { orders: 1, notional: 4900 }, caps: { maxDailyPaperNotional: 5000 } });
  assert.equal(r.approved, false);
  assert.match(r.reason, /daily paper notional/);
});

test('rejects on insufficient buying power for a long', () => {
  const acct = margin({ buyingPower: 100 });
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(acct), account: acct, referencePrice: 200 });
  assert.equal(r.approved, false);
  assert.match(r.reason, /buying power/);
});

test('when margin is disabled, risk uses cash instead of broker buying power', () => {
  const acct = margin({ cash: 100, buyingPower: 60000 });
  const r = assessRisk({
    proposal: longEquity(),
    capabilities: cap(acct),
    account: acct,
    referencePrice: 200,
    marginEnabled: false,
  });
  assert.equal(r.approved, false);
  assert.match(r.reason, /buying power/);
  assert.match(r.reason, /100 < 200/);
});

test('shorts require PAPER_ENABLE_MARGIN=true', () => {
  const acct = margin();
  const r = assessRisk({
    proposal: longEquity({ side: 'sell' }),
    capabilities: cap(acct),
    account: acct,
    referencePrice: 100,
    marginEnabled: false,
  });
  assert.equal(r.approved, false);
  assert.match(r.reason, /PAPER_ENABLE_MARGIN=false/);
});

test('shorts require broker asset shortability data', () => {
  const acct = margin();
  const noAsset = assessRisk({
    proposal: longEquity({ side: 'sell' }),
    capabilities: cap(acct),
    account: acct,
    referencePrice: 100,
  });
  assert.equal(noAsset.approved, false);
  assert.match(noAsset.reason, /shortability data unavailable/);

  const notShortable = assessRisk({
    proposal: longEquity({ side: 'sell' }),
    capabilities: cap(acct),
    account: acct,
    asset: shortableAsset({ shortable: false }),
    referencePrice: 100,
  });
  assert.equal(notShortable.approved, false);
  assert.match(notShortable.reason, /not shortable/);
});

test('shorts require easy_to_borrow === true; unknown/false fail closed', () => {
  const acct = margin();
  const base = {
    proposal: longEquity({ side: 'sell' }),
    capabilities: cap(acct),
    account: acct,
    referencePrice: 100,
  };
  // Explicit not-easy-to-borrow rejects.
  const hardFalse = assessRisk({ ...base, asset: shortableAsset({ easyToBorrow: false }) });
  assert.equal(hardFalse.approved, false);
  assert.match(hardFalse.reason, /easy-to-borrow/);
  // Unknown/null easy_to_borrow must ALSO reject (fail closed, not pass).
  const unknown = assessRisk({ ...base, asset: shortableAsset({ easyToBorrow: null }) });
  assert.equal(unknown.approved, false);
  assert.match(unknown.reason, /easy-to-borrow/);
  // Confirmed easy_to_borrow=true clears the borrow gate.
  const confirmed = assessRisk({ ...base, asset: shortableAsset({ easyToBorrow: true }) });
  assert.equal(confirmed.approved, true);
});

test('equity execute is refused when notional is unverifiable (no reference price)', () => {
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin()), account: margin(), referencePrice: null, executePaper: true });
  assert.equal(r.approved, false);
  assert.match(r.reason, /refusing to execute/);
});

test('equity dry-run is allowed (with caveat) when notional is unverifiable', () => {
  const r = assessRisk({ proposal: longEquity(), capabilities: cap(margin()), account: margin(), referencePrice: null, executePaper: false });
  assert.equal(r.approved, true);
  assert.match(r.reason, /unverified/);
});

test('options without a quote are refused because premium caps cannot be verified', () => {
  const r = assessRisk({ proposal: { assetClass: 'option', side: 'buy', ticker: 'AAPL', quantity: 1 }, capabilities: cap(margin()), account: margin(), referencePrice: null, executePaper: true });
  assert.equal(r.approved, false);
  assert.match(r.reason, /premium quote unavailable/);
});

test('option debit with a validated quote can pass risk caps', () => {
  const r = assessRisk({ proposal: { assetClass: 'option', side: 'buy', ticker: 'AAPL', quantity: 1 }, capabilities: cap(margin()), account: margin(), referencePrice: 2, executePaper: true });
  assert.equal(r.approved, true);
  assert.equal(r.estNotional, 200);
});

test('option execute is refused without an options-eligible account', () => {
  const acct = margin({ optionsTradingLevel: null });
  const r = assessRisk({ proposal: { assetClass: 'option', side: 'buy', ticker: 'AAPL', quantity: 1 }, capabilities: cap(acct), account: acct, referencePrice: null, executePaper: true });
  assert.equal(r.approved, false);
  assert.match(r.reason, /options capability is absent\/unknown/);
});
