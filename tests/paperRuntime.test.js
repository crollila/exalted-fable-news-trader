// tests/paperRuntime.test.js - PAPER runtime audit storage tests.
// No network, no timers beyond injected timestamps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  insertPaperOptionTrade,
  closePaperOptionTrade,
  listPaperOptionTrades,
  startPaperRuntimeSession,
  updatePaperRuntimeSession,
  getPaperRuntimeSession,
  findOpenPaperRuntimeSession,
  insertRecommendationAudit,
  listRecommendationAudits,
  insertUniverseSelections,
  listUniverseSelections,
} from '../src/database/paperRuntime.js';

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

test('paper option trade helper records a long call audit row and close policy outcome', () => {
  const db = freshDb();
  const { id } = insertPaperOptionTrade(db, {
    underlying: 'aapl',
    optionSymbol: 'AAPL260116C00150000',
    expiry: '2026-01-16',
    strike: 150,
    right: 'call',
    quantity: 1,
    premiumEntry: 2.5,
    notionalEntry: 250,
    strategy: 'long_call',
    strategyRationale: 'bullish_call from model direction up',
    exitPolicy: 'close at 50% gain, 50% loss, or before expiry',
  });
  assert.equal(id, 1);
  assert.equal(closePaperOptionTrade(db, {
    id,
    premiumExit: 3.75,
    notionalExit: 375,
    exitReason: 'take_profit_50pct',
    closedAt: '2026-01-12T20:00:00.000Z',
  }).changes, 1);
  const row = listPaperOptionTrades(db)[0];
  assert.equal(row.underlying, 'AAPL');
  assert.equal(row.option_symbol, 'AAPL260116C00150000');
  assert.equal(row.right, 'call');
  assert.equal(row.status, 'closed');
  assert.equal(row.exit_reason, 'take_profit_50pct');
  assert.equal(row.premium_exit, 3.75);
  closeDatabase(db);
});

test('paper runtime sessions persist sanitized counters and JSON maps', () => {
  const db = freshDb();
  const { id } = startPaperRuntimeSession(db, {
    sessionDate: '2026-06-18',
    startedAt: '2026-06-18T13:30:00.000Z',
  });
  const result = updatePaperRuntimeSession(db, id, {
    cycles: 3,
    freshNewsCount: 7,
    classificationCount: 5,
    classificationStatus: { parsed: 4, model_error: 1 },
    skippedReasons: { 'market closed': 2 },
    rejectedReasons: { 'confidence below threshold': 1 },
    ordersSubmitted: 1,
    orderStatus: { accepted: 1 },
    modelRequestCount: 5,
    optionsUsed: 1,
    eodReportStatus: 'sent',
    eodReportSentAt: '2026-06-18T20:01:00.000Z',
  });
  assert.equal(result.changes, 1);
  const row = getPaperRuntimeSession(db, id);
  assert.equal(row.cycles, 3);
  assert.equal(row.fresh_news_count, 7);
  assert.deepEqual(JSON.parse(row.classification_status_json), { parsed: 4, model_error: 1 });
  assert.deepEqual(JSON.parse(row.rejected_reason_json), { 'confidence below threshold': 1 });
  assert.equal(row.options_used, 1);
  assert.equal(row.eod_report_status, 'sent');
  closeDatabase(db);
});

test('findOpenPaperRuntimeSession returns latest open session and ignores closed ones', () => {
  const db = freshDb();
  startPaperRuntimeSession(db, { sessionDate: '2026-06-18', startedAt: '2026-06-18T13:30:00.000Z' });
  const second = startPaperRuntimeSession(db, { sessionDate: '2026-06-18', startedAt: '2026-06-18T14:00:00.000Z' });
  startPaperRuntimeSession(db, { sessionDate: '2026-06-17', startedAt: '2026-06-17T13:30:00.000Z' });
  updatePaperRuntimeSession(db, 1, { status: 'closed' });
  const row = findOpenPaperRuntimeSession(db, '2026-06-18');
  assert.equal(row.id, second.id);
  updatePaperRuntimeSession(db, second.id, { status: 'closed', eodReportStatus: 'sent' });
  assert.equal(findOpenPaperRuntimeSession(db, '2026-06-18'), null);
  assert.equal(getPaperRuntimeSession(db, second.id).eod_report_status, 'sent');
  closeDatabase(db);
});

test('recommendation audits persist versioned evidence summaries only', () => {
  const db = freshDb();
  const { id } = insertRecommendationAudit(db, {
    version: 'paper_research_v1',
    kind: 'constraint_suggestion',
    evidenceWindowStart: '2026-06-18',
    evidenceWindowEnd: '2026-06-18',
    sampleSize: 12,
    dataQuality: 'sufficient',
    observations: [{ slice: 'confidence>=0.75', outcome: '+1.2%' }],
    recommendations: [{ manualEditLine: 'PAPER_CONFIDENCE_THRESHOLD=0.65' }],
  });
  assert.equal(id, 1);
  const row = listRecommendationAudits(db, { kind: 'constraint_suggestion' })[0];
  assert.equal(row.version, 'paper_research_v1');
  assert.equal(row.sample_size, 12);
  assert.deepEqual(JSON.parse(row.recommendations_json), [
    { manualEditLine: 'PAPER_CONFIDENCE_THRESHOLD=0.65' },
  ]);
  closeDatabase(db);
});

test('universe selections record selected and skipped symbol rationale', () => {
  const db = freshDb();
  const cycleAt = '2026-06-18T14:00:00.000Z';
  assert.equal(insertUniverseSelections(db, [
    { cycleAt, symbol: 'aapl', selected: true, rankScore: 3.2, reasons: ['base universe'], source: 'base' },
    { cycleAt, symbol: 'tsla', selected: false, rankScore: 0.4, reasons: ['fresh news'], skippedReason: 'cap reached', source: 'news' },
  ]).inserted, 2);
  const rows = listUniverseSelections(db, { cycleAt });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'AAPL');
  assert.equal(rows[0].selected, 1);
  assert.deepEqual(JSON.parse(rows[1].reasons_json), ['fresh news']);
  assert.equal(rows[1].skipped_reason, 'cap reached');
  closeDatabase(db);
});
