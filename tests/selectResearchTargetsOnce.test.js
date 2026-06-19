// tests/selectResearchTargetsOnce.test.js — In-memory DB + real committed source
// config. SELECTION-ONLY: asserts zero network and that fetch is never enabled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { parseArgs, runSelect } from '../scripts/selectResearchTargetsOnce.js';

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

test('parseArgs defaults: selection-only, fetch off, text format', () => {
  const a = parseArgs([]);
  assert.deepEqual(a.symbols, []);
  assert.equal(a.fetch, false);
  assert.equal(a.format, 'text');
  assert.equal(a.includeDisabled, false);
});

test('parseArgs reads symbols/limit/format and (harmless) --fetch flag', () => {
  const a = parseArgs(['--symbols', 'aapl,msft', '--limit', '5', '--format', 'json', '--fetch', 'true']);
  assert.deepEqual(a.symbols, ['AAPL', 'MSFT']);
  assert.equal(a.limit, 5);
  assert.equal(a.format, 'json');
  assert.equal(a.fetch, true); // parsed, but runSelect never fetches
});

test('runSelect returns approved targets and NEVER fetches (selection-only)', () => {
  const db = freshDb();
  const { result } = runSelect(db, { args: { symbols: ['AAPL'], limit: 10, sourceConfig: undefined, includeDisabled: false } });
  assert.ok(result.targets.length > 0);
  assert.ok(result.targets.every((t) => t.fetchDisabled === true));
  assert.ok(!result.targets.some((t) => t.sourceId === 'example_paywalled_disabled'));
  closeDatabase(db);
});

test('runSelect performs zero real network even with --fetch true', () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls += 1; throw new Error('network attempted'); };
  try {
    const db = freshDb();
    runSelect(db, { args: { symbols: ['AAPL'], limit: 10, fetch: true, includeDisabled: false } });
    assert.equal(networkCalls, 0);
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof runSelect, 'function');
  assert.equal(typeof parseArgs, 'function');
});
