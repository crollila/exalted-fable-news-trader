// tests/database.test.js — Phase 1 foundation validation.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, parseDatabaseUrl } from '../src/config.js';
import { openMemoryDatabase, closeDatabase, listTables } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';

const REQUIRED_TABLES = [
  'news_events',
  'sentiment_scores',
  'price_reactions',
  'paper_trades',
  'paper_option_trades',
  'paper_runtime_sessions',
  'paper_broker_account_snapshots',
  'paper_strategy_performance_snapshots',
  'paper_equity_sizing_decisions',
  'paper_recommendation_audits',
  'paper_universe_selections',
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

function applyMigrationVersions(db, versions) {
  db.exec(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  for (const version of versions) {
    const sql = fs.readFileSync(new URL(`../src/database/migrations/${version}.sql`, import.meta.url), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  }
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

test('migration 004 upgrades an existing database that already applied 001-003', () => {
  const db = openMemoryDatabase();
  applyMigrationVersions(db, ['001_initial', '002_sentiment_scores_phase3', '003_price_reactions_event_study']);
  const result = runMigrations(db);
  assert.deepEqual(result.applied, [
    '004_paper_runtime_research',
    '005_paper_option_execution',
    '006_paper_broker_truth_performance',
    '007_paper_equity_sizing_decisions',
    '008_paper_cap_and_benchmark_metadata',
  ]);
  const tables = listTables(db);
  assert.ok(tables.includes('paper_option_trades'));
  assert.ok(tables.includes('paper_runtime_sessions'));
  assert.ok(tables.includes('paper_broker_account_snapshots'));
  assert.ok(tables.includes('paper_strategy_performance_snapshots'));
  assert.ok(tables.includes('paper_equity_sizing_decisions'));
  // migration 005 adds the option-execution lifecycle columns additively.
  const optionCols = db.prepare("PRAGMA table_info('paper_option_trades')").all().map((c) => c.name);
  assert.ok(optionCols.includes('lifecycle_state'));
  assert.ok(optionCols.includes('entry_order_id'));
  assert.ok(optionCols.includes('realized_pnl_usd'));
  assert.ok(optionCols.includes('entry_filled_avg_price'));
  const tradeCols = db.prepare("PRAGMA table_info('paper_trades')").all().map((c) => c.name);
  assert.ok(tradeCols.includes('broker_order_id'));
  assert.ok(tradeCols.includes('broker_truth_state'));
  const sizingCols = db.prepare("PRAGMA table_info('paper_equity_sizing_decisions')").all().map((c) => c.name);
  assert.ok(sizingCols.includes('requested_target_weight'));
  assert.ok(sizingCols.includes('approved_quantity'));
  assert.ok(sizingCols.includes('manual_override'));
  assert.ok(sizingCols.includes('effective_risk_caps_json'));
  const perfCols = db.prepare("PRAGMA table_info('paper_strategy_performance_snapshots')").all().map((c) => c.name);
  assert.ok(perfCols.includes('spy_current_source'));
  assert.ok(perfCols.includes('spy_current_alignment_status'));
  closeDatabase(db);
});

test('migration 008 preserves existing paper records and leaves new metadata nullable', () => {
  const db = openMemoryDatabase();
  applyMigrationVersions(db, [
    '001_initial',
    '002_sentiment_scores_phase3',
    '003_price_reactions_event_study',
    '004_paper_runtime_research',
    '005_paper_option_execution',
    '006_paper_broker_truth_performance',
    '007_paper_equity_sizing_decisions',
  ]);
  const sessionId = db
    .prepare(
      `INSERT INTO paper_runtime_sessions (session_date, started_at, status)
       VALUES ('2026-06-18', '2026-06-18T13:30:00.000Z', 'open')`
    )
    .run().lastInsertRowid;
  db
    .prepare(
      `INSERT INTO paper_strategy_performance_snapshots
         (runtime_session_id, snapshot_at, snapshot_kind, data_quality, warnings_json)
       VALUES
         (?, '2026-06-18T14:00:00.000Z', 'loop', 'limited', '[]')`
    )
    .run(sessionId);
  db
    .prepare(
      `INSERT INTO paper_equity_sizing_decisions
         (ticker, side, sizing_mode, evidence_count, evidence_quality, explanation, warnings_json)
       VALUES
         ('AAPL', 'buy', 'cold_start', 0, 'limited', 'existing row before 008', '[]')`
    )
    .run();

  const result = runMigrations(db);
  assert.deepEqual(result.applied, ['008_paper_cap_and_benchmark_metadata']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_runtime_sessions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_strategy_performance_snapshots').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_equity_sizing_decisions').get().n, 1);
  const sizing = db.prepare('SELECT effective_risk_caps_json FROM paper_equity_sizing_decisions').get();
  assert.equal(sizing.effective_risk_caps_json, null);
  const perf = db
    .prepare(
      `SELECT spy_baseline_target_at, spy_current_target_at, spy_baseline_source,
              spy_current_source, spy_unavailable_reason
         FROM paper_strategy_performance_snapshots`
    )
    .get();
  assert.equal(perf.spy_baseline_target_at, null);
  assert.equal(perf.spy_current_target_at, null);
  assert.equal(perf.spy_baseline_source, null);
  assert.equal(perf.spy_current_source, null);
  assert.equal(perf.spy_unavailable_reason, null);
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
  assert.deepEqual(config.paperCapabilities, {
    enableShorts: false,
    enableMargin: false,
  });
});

test('paper feature flags default off and parse strict true values', () => {
  const config = loadConfig({
    PAPER_ENABLE_SHORTS: 'true',
    PAPER_ENABLE_MARGIN: 'false',
  });
  assert.deepEqual(config.paperCapabilities, {
    enableShorts: true,
    enableMargin: false,
  });
});

test('live trading without explicit risk confirmation throws', () => {
  assert.throws(() => loadConfig({ LIVE_TRADING_ENABLED: 'true' }), /CONFIRM_LIVE_TRADING/i);
});

test('config uses default DATABASE_URL when unset', () => {
  const config = loadConfig({});
  assert.equal(config.databaseUrl, 'sqlite://data/exalted_fable.sqlite');
  assert.ok(config.databasePath.endsWith(path.join('data', 'exalted_fable.sqlite')));
});
