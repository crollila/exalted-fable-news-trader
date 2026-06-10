// tests/database.test.js — Phase 1 foundation validation.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, parseDatabaseUrl } from '../src/config.js';
import { openMemoryDatabase, closeDatabase, listTables } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';

const REQUIRED_TABLES = [
  'news_events',
  'sentiment_scores',
  'price_reactions',
  'paper_trades',
  'risk_state',
  'rejected_trades',
];

function freshMigratedDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function insertNewsEvent(db, overrides = {}) {
  const row = {
    provider: 'test_provider',
    provider_event_id: 'evt-1',
    ticker: 'AAPL',
    headline: 'Test headline',
    body: 'Test body',
    published_at: '2026-06-09T14:30:00.000Z',
    received_at: '2026-06-09T14:30:01.250Z',
    ...overrides,
  };
  return db
    .prepare(
      `INSERT INTO news_events (provider, provider_event_id, ticker, headline, body, published_at, received_at)
       VALUES (@provider, @provider_event_id, @ticker, @headline, @body, @published_at, @received_at)`
    )
    .run(row);
}

// --- migrations -------------------------------------------------------------

test('migration runs successfully and creates all required tables', () => {
  const db = openMemoryDatabase();
  const { applied } = runMigrations(db);
  assert.ok(applied.includes('001_initial'), 'expected 001_initial to be applied');
  const tables = listTables(db);
  for (const t of REQUIRED_TABLES) {
    assert.ok(tables.includes(t), `missing table: ${t}`);
  }
  assert.ok(tables.includes('schema_migrations'));
  closeDatabase(db);
});

test('migration is idempotent (second run applies nothing)', () => {
  const db = openMemoryDatabase();
  const first = runMigrations(db);
  assert.ok(first.applied.length >= 1);
  const second = runMigrations(db);
  assert.equal(second.applied.length, 0, 'second run should apply nothing');
  assert.deepEqual(second.skipped.sort(), first.applied.sort());
  closeDatabase(db);
});

// --- integrity --------------------------------------------------------------

test('foreign keys are enforced', () => {
  const db = freshMigratedDb();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO sentiment_scores (news_event_id, model, prompt_version) VALUES (99999, 'm', 'v1')`
        )
        .run(),
    /FOREIGN KEY/i
  );
  closeDatabase(db);
});

test('can insert a news event and a related sentiment score', () => {
  const db = freshMigratedDb();
  const { lastInsertRowid: eventId } = insertNewsEvent(db);
  const result = db
    .prepare(
      `INSERT INTO sentiment_scores (news_event_id, model, prompt_version, sentiment_score, confidence, raw_response)
       VALUES (?, 'test-model', 'v1', 0.8, 0.9, '{"score":0.8}')`
    )
    .run(eventId);
  assert.equal(result.changes, 1);
  const joined = db
    .prepare(
      `SELECT n.ticker, s.sentiment_score FROM sentiment_scores s
       JOIN news_events n ON n.id = s.news_event_id WHERE s.id = ?`
    )
    .get(result.lastInsertRowid);
  assert.equal(joined.ticker, 'AAPL');
  assert.equal(joined.sentiment_score, 0.8);
  closeDatabase(db);
});

test('duplicate provider + provider_event_id is rejected', () => {
  const db = freshMigratedDb();
  insertNewsEvent(db);
  assert.throws(() => insertNewsEvent(db), /UNIQUE/i);
  closeDatabase(db);
});

test('rejected_trades requires a non-empty reason', () => {
  const db = freshMigratedDb();
  // NULL reason
  assert.throws(
    () => db.prepare(`INSERT INTO rejected_trades (ticker, reason) VALUES ('AAPL', NULL)`).run(),
    /NOT NULL/i
  );
  // blank reason
  assert.throws(
    () => db.prepare(`INSERT INTO rejected_trades (ticker, reason) VALUES ('AAPL', '  ')`).run(),
    /CHECK/i
  );
  // valid reason works
  const ok = db
    .prepare(`INSERT INTO rejected_trades (ticker, reason) VALUES ('AAPL', 'max trades per day reached')`)
    .run();
  assert.equal(ok.changes, 1);
  closeDatabase(db);
});

// --- config -----------------------------------------------------------------

test('config parses sqlite://data/exalted_fable.sqlite into a normal local path', () => {
  const parsed = parseDatabaseUrl('sqlite://data/exalted_fable.sqlite', '/base');
  assert.ok(!parsed.includes('://'), 'parsed path must not contain a URL scheme');
  assert.equal(parsed, path.resolve('/base', 'data/exalted_fable.sqlite'));
});

test('config rejects non-sqlite DATABASE_URL schemes', () => {
  assert.throws(() => parseDatabaseUrl('postgres://localhost/db'), /Unsupported/i);
});

test('live trading defaults to disabled', () => {
  const config = loadConfig({});
  assert.equal(config.liveTradingEnabled, false);
  assert.equal(config.paperTrading, true);
});

test('live trading without explicit risk confirmation throws', () => {
  assert.throws(() => loadConfig({ LIVE_TRADING_ENABLED: 'true' }), /CONFIRM_LIVE_TRADING/i);
});

test('config uses default DATABASE_URL when unset', () => {
  const config = loadConfig({});
  assert.equal(config.databaseUrl, 'sqlite://data/exalted_fable.sqlite');
  assert.ok(config.databasePath.endsWith(path.join('data', 'exalted_fable.sqlite')));
});
