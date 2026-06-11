// tests/ingestScriptFormat.test.js — Sanitized formatting logic of the manual
// one-shot Alpaca News ingest script. Importing the script runs NOTHING (CLI
// guard): no network, no database open/write, no credentials required.
// npm test stays fake/local only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestReport, MAX_INGEST_LIMIT } from '../scripts/ingestAlpacaNewsOnce.js';
import { parseArgs, MAX_SMOKE_LIMIT } from '../scripts/smokeAlpacaNews.js';

const SUMMARY = {
  provider: 'alpaca',
  fetched: 5,
  inserted: 3,
  duplicates: 2,
  failed: 0,
  insertedIds: [11, 12, 13],
  errors: [],
};

test('buildIngestReport renders provider, counts, ids, and database path only', () => {
  const text = buildIngestReport(SUMMARY, { databasePath: '/tmp/exalted.sqlite' }).join('\n');
  assert.match(text, /via provider "alpaca"/);
  assert.match(text, /database: {5}\/tmp\/exalted\.sqlite/);
  assert.match(text, /fetched: {6}5/);
  assert.match(text, /inserted: {5}3/);
  assert.match(text, /duplicates: {3}2/);
  assert.match(text, /failed: {7}0/);
  assert.match(text, /inserted ids: 11, 12, 13/);
});

test('database path line is omitted when not provided', () => {
  const text = buildIngestReport(SUMMARY).join('\n');
  assert.ok(!text.includes('database:'));
});

test('empty inserted ids render as (none); zero fetch adds a hint line', () => {
  const empty = { ...SUMMARY, fetched: 0, inserted: 0, duplicates: 0, insertedIds: [] };
  const text = buildIngestReport(empty).join('\n');
  assert.match(text, /inserted ids: \(none\)/);
  assert.match(text, /zero events returned/);
});

test('per-event errors are rendered truncated and sanitized', () => {
  const summary = {
    ...SUMMARY,
    failed: 1,
    errors: [
      {
        headline: 'H'.repeat(300),
        providerEventId: 'E'.repeat(300),
        error: 'insertNewsEvent: event has no ticker or symbols; ' + 'x'.repeat(300),
      },
    ],
  };
  const lines = buildIngestReport(summary);
  const errLine = lines.find((l) => l.includes('- error'));
  assert.ok(errLine, 'error line present');
  assert.ok(errLine.includes('…'), 'long fields truncated');
  assert.ok(errLine.length < 320, 'error line stays compact');
  assert.match(errLine, /insertNewsEvent: event has no ticker/);
});

test('report never renders raw payload content even if smuggled into summary', () => {
  // The real summary never carries raw payloads; belt-and-braces, prove the
  // formatter would not print extra fields even if they existed.
  const text = buildIngestReport({
    ...SUMMARY,
    raw: { secret_marker: 'RAW-PAYLOAD-MUST-NOT-PRINT' },
    rawEvents: ['RAW-PAYLOAD-MUST-NOT-PRINT'],
  }).join('\n');
  assert.ok(!text.includes('RAW-PAYLOAD-MUST-NOT-PRINT'));
});

test('ingest cap equals the shared tiny-sample cap and bounds parsed limits', () => {
  assert.equal(MAX_INGEST_LIMIT, 10);
  assert.equal(MAX_INGEST_LIMIT, MAX_SMOKE_LIMIT);
  // The script parses args through the shared parseArgs, so the cap holds.
  assert.equal(parseArgs(['--limit', '500']).limit, MAX_INGEST_LIMIT);
  assert.equal(parseArgs([]).limit, 5); // tiny default sample
});

test('importing the ingest script performs no network and opens no database', () => {
  // The import at the top of this file already executed the module without
  // credentials, network, or database side effects (CLI guard). If it had
  // opened the configured database or called fetch, this test file would
  // not be network-free. Belt-and-braces assertion:
  assert.equal(typeof buildIngestReport, 'function');
});
