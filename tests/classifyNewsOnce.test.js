// tests/classifyNewsOnce.test.js — Network-free tests for the manual capped
// classification/scoring script. Importing the script runs NOTHING (CLI
// guard): no network, no credentials, no model call. The DB-touching tests use
// an in-memory database and the script's own deterministic manual classifier,
// so npm test stays fully offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { listSentimentScoresForEvent } from '../src/database/sentimentScores.js';
import {
  parseArgs,
  manualBaselineResponse,
  buildManualClassifier,
  selectUnscoredEvents,
  buildClassifyReport,
  DEFAULT_CLASSIFY_LIMIT,
  MAX_CLASSIFY_LIMIT,
  MANUAL_MODEL_NAME,
  MANUAL_PROMPT_VERSION,
} from '../scripts/classifyNewsOnce.js';
import { classifyAndStore } from '../src/ingestion/classifyNews.js';

const INSERT_EVENT_SQL = `
  INSERT INTO news_events (provider, provider_event_id, ticker, headline,
    published_at, received_at, news_type)
  VALUES (@provider, @provider_event_id, @ticker, @headline,
    @published_at, @received_at, @news_type)
`;

function insertEvent(db, { id, ticker = 'AAPL', receivedAt, newsType = 'other' }) {
  db.prepare(INSERT_EVENT_SQL).run({
    provider: 'test',
    provider_event_id: `evt-${id}`,
    ticker,
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT',
    published_at: receivedAt,
    received_at: receivedAt,
    news_type: newsType,
  });
}

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

// --- argument parsing & cap enforcement -----------------------------------

test('parseArgs defaults to a single event', () => {
  assert.deepEqual(parseArgs([]), { limit: DEFAULT_CLASSIFY_LIMIT, ids: null });
  assert.equal(DEFAULT_CLASSIFY_LIMIT, 1);
});

test('parseArgs clamps --limit to the hard max and rejects junk', () => {
  assert.equal(parseArgs(['--limit', '100']).limit, MAX_CLASSIFY_LIMIT);
  assert.equal(MAX_CLASSIFY_LIMIT, 5);
  assert.equal(parseArgs(['--limit', '0']).limit, DEFAULT_CLASSIFY_LIMIT);
  assert.equal(parseArgs(['--limit', 'nope']).limit, DEFAULT_CLASSIFY_LIMIT);
  assert.equal(parseArgs(['--limit', '3']).limit, 3);
});

test('parseArgs reads --ids, dedups, and truncates to the hard cap', () => {
  assert.deepEqual(parseArgs(['--ids', '3,1,2']).ids, [3, 1, 2]);
  assert.deepEqual(parseArgs(['--ids', '1,1,2,2']).ids, [1, 2]);
  assert.deepEqual(parseArgs(['--ids', '1,2,3,4,5,6,7']).ids, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseArgs(['--ids', 'a,-1,0']).ids, []);
});

// --- deterministic manual responder ----------------------------------------

test('manualBaselineResponse is deterministic, neutral, and valid JSON', () => {
  const a = manualBaselineResponse({ ticker: 'aapl', news_type: 'earnings' });
  const b = manualBaselineResponse({ ticker: 'aapl', news_type: 'earnings' });
  assert.equal(a, b); // deterministic
  const parsed = JSON.parse(a);
  assert.equal(parsed.sentiment_score, 0);
  assert.equal(parsed.impact_score, 0);
  assert.equal(parsed.confidence, 0);
  assert.equal(parsed.direction, 'unclear'); // never fabricates edge
  assert.equal(parsed.news_type, 'earnings'); // known type preserved
  assert.deepEqual(parsed.affected_symbols, ['AAPL']); // uppercased
});

test('manualBaselineResponse falls back to "other" for unknown/absent news_type', () => {
  assert.equal(JSON.parse(manualBaselineResponse({ ticker: 'X', news_type: 'nope' })).news_type, 'other');
  assert.equal(JSON.parse(manualBaselineResponse({ ticker: 'X' })).news_type, 'other');
  assert.deepEqual(JSON.parse(manualBaselineResponse({})).affected_symbols, []); // no ticker
});

test('the manual classifier carries the manual identity and never calls a model', async () => {
  const classifier = buildManualClassifier();
  assert.equal(classifier.modelName, MANUAL_MODEL_NAME);
  assert.equal(classifier.promptVersion, MANUAL_PROMPT_VERSION);
  // classifyEvent goes through the parser and yields a parsed result offline.
  const result = await classifier.classifyEvent({ ticker: 'AAPL', news_type: 'earnings' });
  assert.equal(result.parserStatus, 'parsed');
  assert.equal(result.output.sentimentScore, 0);
});

// --- selection -------------------------------------------------------------

test('selectUnscoredEvents returns oldest-first unscored rows up to the cap', () => {
  const db = freshDb();
  insertEvent(db, { id: 1, receivedAt: '2026-06-09T12:00:00.000Z' });
  insertEvent(db, { id: 2, receivedAt: '2026-06-09T10:00:00.000Z' });
  insertEvent(db, { id: 3, receivedAt: '2026-06-09T11:00:00.000Z' });

  const one = selectUnscoredEvents(db, { limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].provider_event_id, 'evt-2'); // earliest received_at

  assert.equal(selectUnscoredEvents(db, { limit: 999 }).length, 3); // cap holds at table size
  closeDatabase(db);
});

test('selectUnscoredEvents excludes rows already scored by this model+prompt', async () => {
  const db = freshDb();
  insertEvent(db, { id: 1, receivedAt: '2026-06-09T10:00:00.000Z' });
  insertEvent(db, { id: 2, receivedAt: '2026-06-09T11:00:00.000Z' });

  const classifier = buildManualClassifier();
  const first = selectUnscoredEvents(db, {
    limit: 5,
    modelName: classifier.modelName,
    promptVersion: classifier.promptVersion,
  });
  assert.equal(first.length, 2);
  await classifyAndStore(db, classifier, { eventIds: first.map((r) => r.id) });

  // After scoring both, nothing is left unscored for this model+prompt.
  const second = selectUnscoredEvents(db, {
    limit: 5,
    modelName: classifier.modelName,
    promptVersion: classifier.promptVersion,
  });
  assert.equal(second.length, 0);

  // A different prompt_version is a different experiment → all rows reappear.
  const otherPrompt = selectUnscoredEvents(db, {
    limit: 5,
    modelName: classifier.modelName,
    promptVersion: 'manual_v2',
  });
  assert.equal(otherPrompt.length, 2);
  closeDatabase(db);
});

test('selectUnscoredEvents honors explicit --ids regardless of scored state', () => {
  const db = freshDb();
  for (const id of [1, 2, 3]) insertEvent(db, { id, receivedAt: '2026-06-09T10:00:00.000Z' });
  const rows = selectUnscoredEvents(db, { limit: 5, ids: [3, 1] });
  assert.deepEqual(rows.map((r) => r.provider_event_id).sort(), ['evt-1', 'evt-3']);
  assert.equal(selectUnscoredEvents(db, { limit: 5, ids: [999] }).length, 0);
  closeDatabase(db);
});

// --- no-event behavior -----------------------------------------------------

test('selectUnscoredEvents returns [] on an empty table', () => {
  const db = freshDb();
  assert.deepEqual(selectUnscoredEvents(db, { limit: 5 }), []);
  closeDatabase(db);
});

test('buildClassifyReport explains the no-event case without faking work', () => {
  const text = buildClassifyReport(
    { classified: 0, stored: 0, skipped: 0, failed: 0, statusCounts: {}, errors: [] },
    { selectedCount: 0, model: MANUAL_MODEL_NAME, promptVersion: MANUAL_PROMPT_VERSION }
  ).join('\n');
  assert.match(text, /selected:   0 event/);
  assert.match(text, /no eligible news_events rows/);
});

// --- summary formatting & redaction ---------------------------------------

test('buildClassifyReport renders only sanitized counts and statuses', () => {
  const text = buildClassifyReport(
    { classified: 3, stored: 3, skipped: 1, failed: 0, statusCounts: { parsed: 2, fallback_used: 1 }, errors: [] },
    { selectedCount: 4, model: 'manual_baseline', promptVersion: 'manual_v1' }
  ).join('\n');
  assert.match(text, /model "manual_baseline" prompt "manual_v1"/);
  assert.match(text, /selected:   4 event/);
  assert.match(text, /classified: 3/);
  assert.match(text, /stored:     3/);
  assert.match(text, /skipped:    1/);
  assert.match(text, /statuses:   fallback_used=1  parsed=2/); // sorted
});

test('buildClassifyReport renders per-event errors but never raw payloads', () => {
  const text = buildClassifyReport(
    {
      classified: 0,
      stored: 0,
      skipped: 1,
      failed: 1,
      statusCounts: {},
      errors: [{ newsEventId: 4, error: 'news event not found' }],
    },
    { selectedCount: 1, model: 'manual_baseline', promptVersion: 'manual_v1' }
  ).join('\n');
  assert.match(text, /- error \[event 4\]: news event not found/);
  // A smuggled raw field on the summary is never rendered.
  const sneaky = buildClassifyReport(
    { statusCounts: {}, errors: [], raw: { secret_marker: 'RAW-MUST-NOT-PRINT' } },
    { selectedCount: 1, model: 'm', promptVersion: 'p' }
  ).join('\n');
  assert.ok(!sneaky.includes('RAW-MUST-NOT-PRINT'));
});

// --- integration: real writer path via manual classifier (offline) --------

test('classifyAndStore via the manual classifier writes sanitized sentiment_scores', async () => {
  const db = freshDb();
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: '2026-06-09T10:00:00.000Z', newsType: 'earnings' });
  const classifier = buildManualClassifier();
  const events = selectUnscoredEvents(db, {
    limit: 1,
    modelName: classifier.modelName,
    promptVersion: classifier.promptVersion,
  });
  const summary = await classifyAndStore(db, classifier, { eventIds: events.map((r) => r.id) });
  assert.equal(summary.stored, 1);
  assert.deepEqual(summary.statusCounts, { parsed: 1 });

  const rows = listSentimentScoresForEvent(db, events[0].id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, MANUAL_MODEL_NAME);
  assert.equal(rows[0].sentiment_score, 0);
  assert.equal(rows[0].parser_status, 'parsed');

  const text = buildClassifyReport(summary, {
    selectedCount: events.length,
    model: classifier.modelName,
    promptVersion: classifier.promptVersion,
  }).join('\n');
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof buildClassifyReport, 'function');
  assert.equal(typeof selectUnscoredEvents, 'function');
  assert.equal(typeof buildManualClassifier, 'function');
});
