// tests/optionsProposal.test.js — Pure options-proposal tests; no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeOption, parseOccSymbol, intentForDirection, clampContracts,
  MAX_OPTION_CONTRACTS, DEFAULT_OPTION_CONTRACT_LIMIT,
} from '../src/paper/optionsProposal.js';

const CALL = 'AAPL260116C00150000';
const PUT = 'AAPL260116P00150000';
const EVENT = { id: 1, ticker: 'AAPL' };
const upScore = (over = {}) => ({ direction: 'up', parser_status: 'parsed', sentiment_score: 0.7, impact_score: 0.8, confidence: 0.9, ...over });
const downScore = (over = {}) => ({ direction: 'down', parser_status: 'parsed', sentiment_score: -0.7, impact_score: 0.8, confidence: 0.9, ...over });
const NOW = Date.parse('2026-01-01T00:00:00.000Z'); // ~15 days before the test expiry

test('parseOccSymbol decodes root/expiry/type/strike', () => {
  assert.deepEqual(parseOccSymbol(CALL), { root: 'AAPL', expiry: '2026-01-16', type: 'C', strike: 150 });
  assert.equal(parseOccSymbol('NOTANOCC'), null);
});

test('intentForDirection maps up->call, down->put, else none', () => {
  assert.equal(intentForDirection('up'), 'bullish_call');
  assert.equal(intentForDirection('down'), 'bearish_put');
  assert.equal(intentForDirection('unclear'), 'none');
});

test('clampContracts defaults and caps', () => {
  assert.equal(clampContracts(undefined), DEFAULT_OPTION_CONTRACT_LIMIT);
  assert.equal(clampContracts(999), MAX_OPTION_CONTRACTS);
  assert.equal(clampContracts(0), DEFAULT_OPTION_CONTRACT_LIMIT);
});

test('disabled when allow_options is false', () => {
  const p = proposeOption({ event: EVENT, score: upScore(), allowOptions: false });
  assert.equal(p.enabled, false);
});

test('rejected when PAPER_ENABLE_OPTIONS is false even when allow_options is on', () => {
  const p = proposeOption({ event: EVENT, score: upScore(), allowOptions: true, optionsEnabled: false });
  assert.equal(p.enabled, true);
  assert.equal(p.accepted, false);
  assert.match(p.reason, /PAPER_ENABLE_OPTIONS=false/);
});

test('without a symbol the proposal requires downstream contract discovery', () => {
  const p = proposeOption({ event: EVENT, score: upScore(), allowedSymbols: ['AAPL'], nowMs: NOW });
  assert.equal(p.enabled, true);
  assert.equal(p.accepted, true);
  assert.equal(p.intent, 'bullish_call');
  assert.match(p.reason, /contract discovery and quote validation required/);
});

test('a bullish_call accepts a matching call symbol', () => {
  const p = proposeOption({ event: EVENT, score: upScore(), optionSymbol: CALL, allowedSymbols: ['AAPL'], nowMs: NOW });
  assert.equal(p.accepted, true);
  assert.equal(p.optionType, 'C');
  assert.equal(p.expiry, '2026-01-16');
});

test('a bullish_call rejects a put symbol (type mismatch)', () => {
  const p = proposeOption({ event: EVENT, score: upScore(), optionSymbol: PUT, allowedSymbols: ['AAPL'], nowMs: NOW });
  assert.equal(p.accepted, false);
  assert.match(p.reason, /needs a call/);
});

test('a bearish_put accepts a matching put on direction down', () => {
  const p = proposeOption({ event: EVENT, score: downScore(), optionSymbol: PUT, allowedSymbols: ['AAPL'], nowMs: NOW });
  assert.equal(p.accepted, true);
  assert.equal(p.intent, 'bearish_put');
});

test('rejects an underlying that is not in the allow-list', () => {
  const p = proposeOption({ event: EVENT, score: upScore(), optionSymbol: CALL, allowedSymbols: ['MSFT'], nowMs: NOW });
  assert.equal(p.accepted, false);
  assert.match(p.reason, /not in allowed list/);
});

test('enforces the expiry window', () => {
  const tooSoon = proposeOption({ event: EVENT, score: upScore(), optionSymbol: CALL, allowedSymbols: ['AAPL'], optionExpiryDaysMin: 30, nowMs: NOW });
  assert.equal(tooSoon.accepted, false);
  assert.match(tooSoon.reason, /option-expiry-days-min/);
  const tooFar = proposeOption({ event: EVENT, score: upScore(), optionSymbol: CALL, allowedSymbols: ['AAPL'], optionExpiryDaysMax: 5, nowMs: NOW });
  assert.equal(tooFar.accepted, false);
  assert.match(tooFar.reason, /option-expiry-days-max/);
});

test('unclear direction yields no option intent', () => {
  const p = proposeOption({ event: EVENT, score: upScore({ direction: 'unclear' }), allowedSymbols: ['AAPL'], nowMs: NOW });
  assert.equal(p.accepted, false);
  assert.match(p.reason, /no option intent/);
});

test('respects score thresholds (sub-threshold confidence rejected)', () => {
  const p = proposeOption({ event: EVENT, score: upScore({ confidence: 0.1 }), allowedSymbols: ['AAPL'], nowMs: NOW });
  assert.equal(p.accepted, false);
  assert.match(p.reason, /confidence/);
});
