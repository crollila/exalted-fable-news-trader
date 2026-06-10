// tests/sentimentScores.test.js — Migration 002 + sentiment_scores writer.
// Fixture classifier/parser results only: no model calls, no provider APIs,
// no trading logic. Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { insertNewsEvent } from '../src/database/newsEvents.js';
import {
  insertSentimentScore,
  getSentimentScoreById,
  listSentimentScoresForEvent,
  countSentimentScoresByStatus,
} from '../src/database/sentimentScores.js';
import { parseModelResponse } from '../src/sentiment/parseModelResponse.js';
import { createFixtureClassifier } from '../src/sentiment/fixtureClassifier.js';
import { normalizeNewsEvent } from '../src/providers/normalize.js';
import {
  VALID_RESPONSE,
  MALFORMED_JSON_RESPONSE,
  MISSING_FIELD_RESPONSE,
  OUT_OF_RANGE_RESPONSE,
  UNKNOWN_ENUM_RESPONSE,
} from './fixtures/modelResponses.js';

const OPTS = { promptVersion: 'sentiment_v1', modelName: 'fixture' };

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedEvent(db) {
  const event = normalizeNewsEvent({
    provider: 'mock',
    providerEventId: 'evt-1',
    headline: 'Seed event',
    publishedAt: '2026-06-09T10:00:00Z',
    symbols: ['AAPL'],
  });
  return insertNewsEvent(db, event).id;
}

// --- migration ------------------------------------------------------------

test('migration 002 applies cleanly and is idempotent with the runner', () => {
  const db = openMemoryDatabase();
  const first = runMigrations(db);
  assert.deepEqual(first.applied, ['001_initial', '002_sentiment_scores_phase3']);
  const second = runMigrations(db);
  assert.equal(second.applied.length, 0);
  assert.ok(second.skipped.includes('002_sentiment_scores_phase3'));
  closeDatabase(db);
});

test('new columns exist as designed', () => {
  const db = freshDb();
  const columns = db.prepare("PRAGMA table_info('sentiment_scores')").all().map((c) => c.name);
  for (const col of ['parser_status', 'impact_score', 'direction', 'time_horizon', 'detail']) {
    assert.ok(columns.includes(col), `missing column: ${col}`);
  }
  // index from 002 exists
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sentiment_scores'")
    .all()
    .map((r) => r.name);
  assert.ok(indexes.includes('idx_sentiment_scores_status'));
  closeDatabase(db);
});

// --- writer: success path ---------------------------------------------------

test('valid parsed classifier output inserts with full column mapping', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  const result = parseModelResponse(VALID_RESPONSE, OPTS);
  const { id } = insertSentimentScore(db, eventId, result);

  const row = getSentimentScoreById(db, id);
  assert.equal(row.news_event_id, eventId);
  assert.equal(row.model, 'fixture');
  assert.equal(row.prompt_version, 'sentiment_v1');
  assert.equal(row.parser_status, 'parsed');
  assert.equal(row.parse_ok, 1);
  assert.equal(row.sentiment_score, 0.62);
  assert.equal(row.news_type, 'earnings');
  assert.equal(row.confidence, 0.85);
  assert.equal(row.impact_score, 0.7);
  assert.equal(row.direction, 'up');
  assert.equal(row.time_horizon, 'intraday');
  assert.deepEqual(row.detail.affected_symbols, ['AAPL', 'MSFT']);
  assert.equal(row.detail.rationale, 'Strong beat with raised guidance.');
  assert.deepEqual(row.detail.errors, []);
  closeDatabase(db);
});

// --- writer: failures are data, not discarded --------------------------------

test('all failure-mode parser results are stored as rows, not discarded', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  const cases = [
    [MALFORMED_JSON_RESPONSE, 'malformed_json'],
    [MISSING_FIELD_RESPONSE, 'missing_required_field'],
    [OUT_OF_RANGE_RESPONSE, 'invalid_score_range'],
  ];
  for (const [raw, expectedStatus] of cases) {
    const result = parseModelResponse(raw, OPTS);
    const { id } = insertSentimentScore(db, eventId, result);
    const row = getSentimentScoreById(db, id);
    assert.equal(row.parser_status, expectedStatus);
    assert.equal(row.parse_ok, 0); // derived: not an OK status
    assert.equal(row.sentiment_score, null); // failed parses store NULL scores
    assert.equal(row.impact_score, null);
    assert.equal(row.direction, null);
    assert.ok(row.detail.errors.length > 0); // failure reason preserved
  }
  assert.equal(listSentimentScoresForEvent(db, eventId).length, 3);
  closeDatabase(db);
});

test('fallback_used results store output AND parse_ok=1 with errors recorded', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  const result = parseModelResponse(UNKNOWN_ENUM_RESPONSE, OPTS);
  const { id } = insertSentimentScore(db, eventId, result);
  const row = getSentimentScoreById(db, id);
  assert.equal(row.parser_status, 'fallback_used');
  assert.equal(row.parse_ok, 1); // fallback still yields usable output
  assert.equal(row.news_type, 'other'); // fallback value stored
  assert.equal(row.direction, 'unclear');
  assert.equal(row.detail.errors.length, 2); // both fallbacks documented
  closeDatabase(db);
});

test('model_error results from the fixture classifier are stored', async () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  const classifier = createFixtureClassifier({
    respond: () => {
      throw new Error('simulated outage');
    },
  });
  const result = await classifier.classifyEvent({ headline: 'x' });
  const { id } = insertSentimentScore(db, eventId, result);
  const row = getSentimentScoreById(db, id);
  assert.equal(row.parser_status, 'model_error');
  assert.equal(row.parse_ok, 0);
  assert.equal(row.raw_response, ''); // nothing came back; still a string
  assert.match(row.detail.errors[0], /simulated outage/);
  closeDatabase(db);
});

test('raw model response is preserved byte-for-byte in stored rows', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  for (const raw of [VALID_RESPONSE, MALFORMED_JSON_RESPONSE, UNKNOWN_ENUM_RESPONSE]) {
    const { id } = insertSentimentScore(db, eventId, parseModelResponse(raw, OPTS));
    assert.equal(getSentimentScoreById(db, id).raw_response, raw);
  }
  closeDatabase(db);
});

test('countSentimentScoresByStatus aggregates correctly', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  insertSentimentScore(db, eventId, parseModelResponse(VALID_RESPONSE, OPTS));
  insertSentimentScore(db, eventId, parseModelResponse(VALID_RESPONSE, OPTS));
  insertSentimentScore(db, eventId, parseModelResponse(MALFORMED_JSON_RESPONSE, OPTS));
  assert.deepEqual(countSentimentScoresByStatus(db), { parsed: 2, malformed_json: 1 });
  closeDatabase(db);
});

// --- writer: caller-input validation ------------------------------------------

test('writer rejects invalid caller input clearly', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  const good = parseModelResponse(VALID_RESPONSE, OPTS);

  // bad newsEventId
  assert.throws(() => insertSentimentScore(db, 0, good), /newsEventId/);
  assert.throws(() => insertSentimentScore(db, 'x', good), /newsEventId/);
  // unknown news_event_id → FK enforcement
  assert.throws(() => insertSentimentScore(db, 99999, good), /FOREIGN KEY/i);
  // structurally invalid results (contract gate)
  assert.throws(() => insertSentimentScore(db, eventId, null), /object/);
  assert.throws(
    () => insertSentimentScore(db, eventId, { ...good, promptVersion: '' }),
    /promptVersion/
  );
  assert.throws(
    () => insertSentimentScore(db, eventId, { ...good, parserStatus: 'nonsense' }),
    /parserStatus/
  );
  assert.throws(
    () => insertSentimentScore(db, eventId, { ...good, rawModelResponse: undefined }),
    /rawModelResponse/
  );
  // nothing was stored by any rejected call
  assert.equal(listSentimentScoresForEvent(db, eventId).length, 0);
  closeDatabase(db);
});
