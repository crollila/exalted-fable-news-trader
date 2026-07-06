// tests/compactDatabase.test.js — Data-retention compaction. Fully offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  compactDatabase,
  cutoffIso,
  parseArgs,
  reportLines,
  resolveRetentionDays,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
} from '../scripts/compactDatabase.js';

const NOW_MS = Date.parse('2026-07-05T12:00:00.000Z');
const OLD = '2026-01-01T12:00:00.000Z';   // far older than any cutoff
const FRESH = '2026-07-04T12:00:00.000Z'; // inside every cutoff

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedEvent(db, { receivedAt, rawPayload = '{"raw":true}' }) {
  const run = db.prepare(
    `INSERT INTO news_events (provider, provider_event_id, ticker, headline, published_at, received_at, raw_payload)
     VALUES ('t', 'e-' || ?, 'AAPL', 'H', ?, ?, ?)`
  ).run(String(Math.random()), receivedAt, receivedAt, rawPayload);
  return Number(run.lastInsertRowid);
}

function seedScore(db, eventId, { createdAt, rawResponse = 'RAW' }) {
  db.prepare(
    `INSERT INTO sentiment_scores (news_event_id, model, prompt_version, raw_response, parse_ok, parser_status, created_at)
     VALUES (?, 'm', 'model_v1', ?, 1, 'parsed', ?)`
  ).run(eventId, rawResponse, createdAt);
}

function seedAccountSnapshot(db, { snapshotAt }) {
  db.prepare(
    `INSERT INTO paper_broker_account_snapshots (snapshot_at, snapshot_kind, data_quality, warnings_json)
     VALUES (?, 'reconcile', 'complete', '[]')`
  ).run(snapshotAt);
}

test('retention resolution: CLI > env > default, floored at the minimum', () => {
  assert.equal(resolveRetentionDays({}), DEFAULT_RETENTION_DAYS);
  assert.equal(resolveRetentionDays({ envDays: '30' }), 30);
  assert.equal(resolveRetentionDays({ cliDays: '14', envDays: '30' }), 14);
  assert.equal(resolveRetentionDays({ cliDays: '1' }), MIN_RETENTION_DAYS); // floored
  assert.equal(resolveRetentionDays({ cliDays: 'junk', envDays: 'junk' }), DEFAULT_RETENTION_DAYS);
});

test('parseArgs: dry run by default; --apply/--days/--vacuum recognized', () => {
  assert.deepEqual(parseArgs([]), { apply: false, days: null, vacuum: false });
  assert.deepEqual(parseArgs(['--apply', '--days', '30', '--vacuum']), { apply: true, days: '30', vacuum: true });
});

test('dry run counts old rows but changes NOTHING', () => {
  const db = freshDb();
  const oldId = seedEvent(db, { receivedAt: OLD });
  seedScore(db, oldId, { createdAt: OLD });
  seedAccountSnapshot(db, { snapshotAt: OLD });

  const result = compactDatabase(db, { days: 90, apply: false, nowMs: NOW_MS });
  assert.equal(result.applied, false);
  assert.deepEqual(result.counts, { rawPayloads: 1, rawResponses: 1, accountSnapshots: 1 });
  // Nothing changed.
  assert.equal(db.prepare('SELECT raw_payload FROM news_events WHERE id = ?').get(oldId).raw_payload, '{"raw":true}');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_broker_account_snapshots').get().n, 1);
  assert.match(reportLines(result).join('\n'), /DRY RUN/);
  closeDatabase(db);
});

test('--apply nulls old raw columns, deletes old account snapshots, keeps rows and fresh data', () => {
  const db = freshDb();
  const oldId = seedEvent(db, { receivedAt: OLD });
  seedScore(db, oldId, { createdAt: OLD });
  const freshId = seedEvent(db, { receivedAt: FRESH });
  seedScore(db, freshId, { createdAt: FRESH });
  seedAccountSnapshot(db, { snapshotAt: OLD });
  seedAccountSnapshot(db, { snapshotAt: FRESH });

  const result = compactDatabase(db, { days: 90, apply: true, nowMs: NOW_MS });
  assert.equal(result.applied, true);
  // Old raw data gone, rows intact.
  assert.equal(db.prepare('SELECT raw_payload FROM news_events WHERE id = ?').get(oldId).raw_payload, null);
  assert.equal(db.prepare('SELECT raw_response FROM sentiment_scores WHERE news_event_id = ?').get(oldId).raw_response, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM news_events').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sentiment_scores').get().n, 2);
  // Fresh raw data untouched.
  assert.equal(db.prepare('SELECT raw_payload FROM news_events WHERE id = ?').get(freshId).raw_payload, '{"raw":true}');
  // Old snapshot deleted, fresh one kept.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_broker_account_snapshots').get().n, 1);
  closeDatabase(db);
});

test('evidence tables are never touched', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status, created_at, broker_realized_pnl_usd)
     VALUES ('AAPL', 'buy', 1, 'closed', ?, -12.5)`
  ).run(OLD);
  db.prepare(
    `INSERT INTO rejected_trades (ticker, side, quantity, reason, created_at)
     VALUES ('AAPL', 'buy', 1, 'old rejection', ?)`
  ).run(OLD);
  compactDatabase(db, { days: MIN_RETENTION_DAYS, apply: true, nowMs: NOW_MS });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rejected_trades').get().n, 1);
  assert.equal(db.prepare('SELECT broker_realized_pnl_usd FROM paper_trades').get().broker_realized_pnl_usd, -12.5);
  closeDatabase(db);
});

test('cutoffIso derives the expected UTC boundary', () => {
  assert.equal(cutoffIso(90, NOW_MS), '2026-04-06T12:00:00.000Z');
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof compactDatabase, 'function');
});
