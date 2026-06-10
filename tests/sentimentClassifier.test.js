// tests/sentimentClassifier.test.js — Phase 3 step 1: classifier contract
// and parser, fixture-only. No model calls, no API keys, no writes to
// sentiment_scores. Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARSER_STATUS,
  validateClassifier,
  assertClassificationResult,
} from '../src/sentiment/classifierContract.js';
import { parseModelResponse } from '../src/sentiment/parseModelResponse.js';
import { createFixtureClassifier } from '../src/sentiment/fixtureClassifier.js';
import {
  VALID_RESPONSE,
  MINIMAL_VALID_RESPONSE,
  MALFORMED_JSON_RESPONSE,
  NON_OBJECT_JSON_RESPONSE,
  MISSING_FIELD_RESPONSE,
  OUT_OF_RANGE_RESPONSE,
  NON_NUMERIC_SCORE_RESPONSE,
  UNKNOWN_ENUM_RESPONSE,
} from './fixtures/modelResponses.js';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { countNewsEvents } from '../src/database/newsEvents.js';
import { createMockProvider } from '../src/providers/mockProvider.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';

const OPTS = { promptVersion: 'sentiment_v1', modelName: 'fixture' };

// --- parser: success paths ----------------------------------------------------

test('valid output parses correctly', () => {
  const r = parseModelResponse(VALID_RESPONSE, OPTS);
  assertClassificationResult(r);
  assert.equal(r.parserStatus, PARSER_STATUS.PARSED);
  assert.equal(r.output.newsType, 'earnings');
  assert.equal(r.output.sentimentScore, 0.62);
  assert.equal(r.output.impactScore, 0.7);
  assert.equal(r.output.confidence, 0.85);
  assert.equal(r.output.direction, 'up');
  assert.equal(r.output.timeHorizon, 'intraday');
  assert.deepEqual(r.output.affectedSymbols, ['AAPL', 'MSFT']); // uppercased, trimmed
  assert.equal(r.output.rationale, 'Strong beat with raised guidance.');
  assert.deepEqual(r.errors, []);
});

test('minimal valid output parses; optional fields default safely', () => {
  const r = parseModelResponse(MINIMAL_VALID_RESPONSE, OPTS);
  assert.equal(r.parserStatus, PARSER_STATUS.PARSED);
  assert.equal(r.output.timeHorizon, null);
  assert.deepEqual(r.output.affectedSymbols, []);
  assert.equal(r.output.rationale, null);
});

// --- parser: failure paths (never throws on model output) ---------------------

test('malformed JSON is handled safely', () => {
  const r = parseModelResponse(MALFORMED_JSON_RESPONSE, OPTS);
  assertClassificationResult(r);
  assert.equal(r.parserStatus, PARSER_STATUS.MALFORMED_JSON);
  assert.equal(r.output, null);
  assert.ok(r.errors.length > 0);
  // valid JSON that is not an object is also malformed for our purposes
  const r2 = parseModelResponse(NON_OBJECT_JSON_RESPONSE, OPTS);
  assert.equal(r2.parserStatus, PARSER_STATUS.MALFORMED_JSON);
});

test('missing required fields are labeled safely', () => {
  const r = parseModelResponse(MISSING_FIELD_RESPONSE, OPTS);
  assert.equal(r.parserStatus, PARSER_STATUS.MISSING_REQUIRED_FIELD);
  assert.equal(r.output, null);
  assert.match(r.errors[0], /impact_score/);
});

test('invalid score ranges are labeled safely', () => {
  const r = parseModelResponse(OUT_OF_RANGE_RESPONSE, OPTS);
  assert.equal(r.parserStatus, PARSER_STATUS.INVALID_SCORE_RANGE);
  assert.equal(r.output, null);
  assert.match(r.errors[0], /sentiment_score/);
  // non-numeric scores are range failures too
  const r2 = parseModelResponse(NON_NUMERIC_SCORE_RESPONSE, OPTS);
  assert.equal(r2.parserStatus, PARSER_STATUS.INVALID_SCORE_RANGE);
});

test('unknown enum values fall back safely with fallback_used status', () => {
  const r = parseModelResponse(UNKNOWN_ENUM_RESPONSE, OPTS);
  assert.equal(r.parserStatus, PARSER_STATUS.FALLBACK_USED);
  assert.equal(r.output.newsType, 'other');
  assert.equal(r.output.direction, 'unclear');
  assert.equal(r.errors.length, 2); // both fallbacks recorded
});

test('raw model response is preserved byte-for-byte in all outcomes', () => {
  for (const raw of [
    VALID_RESPONSE,
    MALFORMED_JSON_RESPONSE,
    MISSING_FIELD_RESPONSE,
    OUT_OF_RANGE_RESPONSE,
    UNKNOWN_ENUM_RESPONSE,
  ]) {
    assert.equal(parseModelResponse(raw, OPTS).rawModelResponse, raw);
  }
});

test('prompt_version is required (caller bug fails loudly)', () => {
  assert.throws(() => parseModelResponse(VALID_RESPONSE, { modelName: 'fixture' }), /promptVersion/);
  assert.throws(
    () => parseModelResponse(VALID_RESPONSE, { promptVersion: '  ', modelName: 'fixture' }),
    /promptVersion/
  );
  assert.throws(
    () => parseModelResponse(VALID_RESPONSE, { promptVersion: 'sentiment_v1' }),
    /modelName/
  );
  // and the result always carries it
  const r = parseModelResponse(VALID_RESPONSE, OPTS);
  assert.equal(r.promptVersion, 'sentiment_v1');
});

// --- fixture classifier --------------------------------------------------------

test('fixture classifier satisfies the classifier contract', () => {
  const classifier = createFixtureClassifier({ respond: () => VALID_RESPONSE });
  validateClassifier(classifier);
  assert.equal(classifier.name, 'fixture');
  assert.equal(classifier.promptVersion, 'sentiment_v1');
});

test('fixture classifier is deterministic (same event → same result)', async () => {
  const classifier = createFixtureClassifier({ respond: () => VALID_RESPONSE });
  const event = { headline: 'x' };
  const a = await classifier.classifyEvent(event);
  const b = await classifier.classifyEvent(event);
  assert.deepEqual(a, b);
});

test('classifier never throws: responder failure becomes model_error', async () => {
  const classifier = createFixtureClassifier({
    respond: () => {
      throw new Error('simulated model outage');
    },
  });
  const r = await classifier.classifyEvent({ headline: 'x' });
  assertClassificationResult(r);
  assert.equal(r.parserStatus, PARSER_STATUS.MODEL_ERROR);
  assert.equal(r.output, null);
  assert.match(r.errors[0], /simulated model outage/);
});

test('default classifier has no responder and reports model_error, never network', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network attempted');
  };
  try {
    const classifier = createFixtureClassifier(); // nothing injected
    const r = await classifier.classifyEvent({ headline: 'x' });
    assert.equal(r.parserStatus, PARSER_STATUS.MODEL_ERROR);
    assert.match(r.errors[0], /no responder configured/i);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- classification failures never block ingestion -----------------------------

test('parser failures do not imply failed ingestion (and write nothing to sentiment_scores)', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);

  // Ingest events normally...
  const provider = createMockProvider([
    { id: 'e-1', symbols: ['AAPL'], headline: 'Event one', created_at: '2026-06-09T10:00:00Z' },
    { id: 'e-2', symbols: ['MSFT'], headline: 'Event two', created_at: '2026-06-09T11:00:00Z' },
  ]);
  const ingest = await ingestNews(db, provider);
  assert.equal(ingest.inserted, 2);

  // ...then classify with an always-malformed "model". Every classification
  // fails, but ingestion results are untouched and nothing throws.
  const classifier = createFixtureClassifier({ respond: () => MALFORMED_JSON_RESPONSE });
  const events = await provider.fetchNews();
  for (const event of events) {
    const r = await classifier.classifyEvent(event);
    assert.equal(r.parserStatus, PARSER_STATUS.MALFORMED_JSON);
  }

  assert.equal(countNewsEvents(db), 2); // ingested rows intact
  const scoreCount = db.prepare('SELECT COUNT(*) AS n FROM sentiment_scores').get().n;
  assert.equal(Number(scoreCount), 0); // Phase 3 step 1 writes nothing here
  closeDatabase(db);
});
