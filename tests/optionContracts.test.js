// tests/optionContracts.test.js - Pure/injected tests for minimal long options.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  optionExpirationWindow,
  validateUnderlyingAsset,
  chooseOptionContract,
  validateOptionQuote,
  enrichOptionProposal,
  DEFAULT_OPTION_EXIT_POLICY,
} from '../src/paper/optionContracts.js';

const NOW = Date.parse('2026-06-18T14:00:00.000Z');

function baseProposal(overrides = {}) {
  return {
    enabled: true,
    accepted: true,
    intent: 'bullish_call',
    underlying: 'AAPL',
    contracts: 1,
    optionMaxPremium: 300,
    ...overrides,
  };
}

test('optionExpirationWindow builds bounded UTC date filters', () => {
  const w = optionExpirationWindow({ nowMs: NOW, minDays: 7, maxDays: 30 });
  assert.equal(w.expirationDateGte, '2026-06-25');
  assert.equal(w.expirationDateLte, '2026-07-18');
});

test('validateUnderlyingAsset requires the selected underlying to be tradable', () => {
  assert.equal(validateUnderlyingAsset(null, 'AAPL').ok, false);
  assert.equal(validateUnderlyingAsset({ symbol: 'AAPL', status: 'active', tradable: false }, 'AAPL').ok, false);
  assert.equal(validateUnderlyingAsset({ symbol: 'AAPL', status: 'inactive', tradable: true }, 'AAPL').ok, false);
  assert.equal(validateUnderlyingAsset({ symbol: 'AAPL', status: 'active', tradable: true }, 'AAPL').ok, true);
});

test('chooseOptionContract selects only active tradable matching long-call contracts', () => {
  const result = chooseOptionContract([
    { symbol: 'AAPL260710P00150000', underlyingSymbol: 'AAPL', status: 'active', tradable: true, expirationDate: '2026-07-10', strikePrice: 150, type: 'put', openInterest: 999 },
    { symbol: 'AAPL260710C00150000', underlyingSymbol: 'AAPL', status: 'inactive', tradable: true, expirationDate: '2026-07-10', strikePrice: 150, type: 'call', openInterest: 999 },
    { symbol: 'AAPL260710C00155000', underlyingSymbol: 'AAPL', status: 'active', tradable: true, expirationDate: '2026-07-10', strikePrice: 155, type: 'call', openInterest: 10 },
    { symbol: 'AAPL260710C00145000', underlyingSymbol: 'AAPL', status: 'active', tradable: true, expirationDate: '2026-07-10', strikePrice: 145, type: 'call', openInterest: 100 },
  ], { underlying: 'AAPL', right: 'call', nowMs: NOW, minDays: 1, maxDays: 60 });
  assert.equal(result.accepted, true);
  assert.equal(result.contract.symbol, 'AAPL260710C00145000');
});

test('validateOptionQuote rejects missing/illiquid/over-cap quotes and accepts bounded debit', () => {
  assert.match(validateOptionQuote({ bid: 0, ask: 1 }, { maxPremium: 200 }).reason, /positive bid/);
  assert.match(validateOptionQuote({ bid: 1, ask: 3 }, { maxPremium: 500 }).reason, /spread/);
  assert.match(validateOptionQuote({ bid: 1.9, ask: 2.1 }, { maxPremium: 100 }).reason, /exceeds/);
  const ok = validateOptionQuote({ bid: 1.9, ask: 2.1, mid: 2 }, { contracts: 1, maxPremium: 250 });
  assert.equal(ok.accepted, true);
  assert.equal(ok.notional, 210);
});

test('enrichOptionProposal validates asset, contract, quote, and returns a long-call proposal', async () => {
  const calls = [];
  const fakeClient = {
    getAsset: async (symbol) => {
      calls.push(['asset', symbol]);
      return { symbol, status: 'active', tradable: true };
    },
    getOptionContracts: async (query) => {
      calls.push(['contracts', query.type, query.expirationDateGte, query.expirationDateLte]);
      return {
        contracts: [
          {
            symbol: 'AAPL260710C00150000',
            underlyingSymbol: 'AAPL',
            status: 'active',
            tradable: true,
            expirationDate: '2026-07-10',
            strikePrice: 150,
            type: 'call',
            openInterest: 123,
          },
        ],
      };
    },
    getOptionQuote: async (query) => {
      calls.push(['quote', query.optionSymbol]);
      return { symbol: query.optionSymbol, bid: 2.4, ask: 2.6, mid: 2.5 };
    },
  };
  const enriched = await enrichOptionProposal({
    proposal: baseProposal(),
    paperClient: fakeClient,
    optionExpiryDaysMin: 1,
    optionExpiryDaysMax: 60,
    nowMs: NOW,
  });
  assert.equal(enriched.accepted, true);
  assert.equal(enriched.optionSymbol, 'AAPL260710C00150000');
  assert.equal(enriched.right, 'call');
  assert.equal(enriched.strategy, 'long_call');
  assert.equal(enriched.premiumEntry, 2.6);
  assert.equal(enriched.notionalEntry, 260);
  assert.equal(enriched.exitPolicy, DEFAULT_OPTION_EXIT_POLICY);
  assert.deepEqual(calls.map((c) => c[0]), ['asset', 'contracts', 'quote']);
});

test('enrichOptionProposal returns a structured rejection when discovery has no contract', async () => {
  const rejected = await enrichOptionProposal({
    proposal: baseProposal(),
    paperClient: {
      getAsset: async () => ({ symbol: 'AAPL', status: 'active', tradable: true }),
      getOptionContracts: async () => ({ contracts: [] }),
    },
    nowMs: NOW,
  });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /no eligible tradable option contract/);
});
