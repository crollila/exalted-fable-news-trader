// tests/candidateUniverse.test.js - Controlled symbol universe selection.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  rankCandidateUniverse,
  selectCandidateUniverse,
  DEFAULT_MAX_SYMBOLS_PER_CYCLE,
} from '../src/paper/candidateUniverse.js';

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

test('rankCandidateUniverse preserves base symbols, ranks model/news signals, and caps output', () => {
  const ranked = rankCandidateUniverse({
    baseSymbols: ['aapl', 'msft'],
    newsSymbols: ['nvda', 'aapl'],
    affectedSymbols: ['tsla', 'nvda'],
    maxSymbols: 3,
  });
  assert.deepEqual(ranked.filter((r) => r.selected).map((r) => r.symbol), ['AAPL', 'MSFT', 'NVDA']);
  const skipped = ranked.find((r) => r.symbol === 'TSLA');
  assert.equal(skipped.selected, false);
  assert.match(skipped.skippedReason, /cap reached/);
  assert.ok(ranked.find((r) => r.symbol === 'AAPL').reasons.includes('user base universe'));
});

test('selectCandidateUniverse uses stored news/model metadata and records reasons', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO news_events (provider, provider_event_id, ticker, headline, published_at, received_at, news_type)
     VALUES ('t','n1','NVDA','H','2026-06-18T14:00:00.000Z','2026-06-18T14:01:00.000Z','earnings')`
  ).run();
  db.prepare(
    `INSERT INTO sentiment_scores (news_event_id, model, prompt_version, raw_response, parse_ok, parser_status, detail)
     VALUES (1,'m','model_v1','{}',1,'parsed','{"affected_symbols":["TSLA","NVDA"]}')`
  ).run();
  const result = selectCandidateUniverse(db, {
    baseSymbols: ['AAPL'],
    since: '2026-06-18T13:00:00.000Z',
    maxSymbols: 2,
    cycleAt: '2026-06-18T14:05:00.000Z',
  });
  assert.deepEqual(result.selectedSymbols, ['AAPL', 'NVDA']);
  const rows = db.prepare('SELECT symbol, selected, skipped_reason, reasons_json FROM paper_universe_selections ORDER BY id').all();
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.symbol === 'TSLA').selected, 0);
  assert.deepEqual(JSON.parse(rows.find((r) => r.symbol === 'NVDA').reasons_json), [
    'fresh stored news relevance',
    'model identified affected symbol',
  ]);
  closeDatabase(db);
});

test('candidate universe default cap is finite', () => {
  assert.equal(DEFAULT_MAX_SYMBOLS_PER_CYCLE, 25);
});
