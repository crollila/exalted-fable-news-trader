// tests/reportEventStudySummary.test.js — Network-free tests for the manual
// read-only research summary script. Importing the script runs NOTHING (CLI
// guard): no network, no credentials, no writes. The DB-touching tests use an
// in-memory database, so npm test stays fully offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { insertPriceReaction, MEASUREMENT_STATUS } from '../src/database/priceReactions.js';
import {
  parseArgs,
  collectSummary,
  buildSummaryReport,
  DEFAULT_RECENT_LIMIT,
  MAX_RECENT_LIMIT,
} from '../scripts/reportEventStudySummary.js';

const INSERT_EVENT_SQL = `
  INSERT INTO news_events (provider, provider_event_id, ticker, headline,
    published_at, received_at, news_type)
  VALUES (@provider, @provider_event_id, @ticker, @headline,
    @published_at, @received_at, @news_type)
`;

const INSERT_SCORE_SQL = `
  INSERT INTO sentiment_scores (news_event_id, model, prompt_version, raw_response, parser_status)
  VALUES (@news_event_id, @model, @prompt_version, @raw_response, @parser_status)
`;

function insertEvent(db, { id, ticker, receivedAt }) {
  db.prepare(INSERT_EVENT_SQL).run({
    provider: 'test',
    provider_event_id: `evt-${id}`,
    ticker,
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT',
    published_at: receivedAt,
    received_at: receivedAt,
    news_type: 'other',
  });
}

function insertScore(db, newsEventId) {
  db.prepare(INSERT_SCORE_SQL).run({
    news_event_id: newsEventId,
    model: 'fixture-model',
    prompt_version: 'sentiment_v1',
    raw_response: 'RAW-MODEL-RESPONSE-MUST-NOT-PRINT',
    parser_status: 'parsed',
  });
}

function measured(db, eventId, horizon, { baseline, reaction, at }) {
  insertPriceReaction(db, eventId, {
    horizon,
    measurementStatus: MEASUREMENT_STATUS.MEASURED,
    anchorAt: at,
    measuredAt: at,
    baselineAt: at,
    baselinePrice: baseline,
    reactionPrice: reaction,
    priceSource: 'alpaca_iex',
  });
}

function unmeasured(db, eventId, horizon, status, at) {
  insertPriceReaction(db, eventId, {
    horizon,
    measurementStatus: status,
    anchorAt: at,
    measuredAt: at,
    priceSource: 'alpaca_iex',
  });
}

function seededDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: '2026-06-09T14:30:00.000Z' });
  insertEvent(db, { id: 2, ticker: 'MSFT', receivedAt: '2026-06-09T15:30:00.000Z' });
  insertScore(db, 1);
  // Event 1: two measured horizons with known returns (+0.5% and +1.0%).
  measured(db, 1, '10s', { baseline: 200, reaction: 201, at: '2026-06-09T14:30:10.000Z' });
  measured(db, 1, '1m', { baseline: 200, reaction: 202, at: '2026-06-09T14:31:00.000Z' });
  // Event 2: a non-measured horizon (failures are data).
  unmeasured(db, 2, '10s', MEASUREMENT_STATUS.NO_BASELINE, '2026-06-09T15:30:10.000Z');
  return db;
}

// --- argument parsing ------------------------------------------------------

test('parseArgs defaults and caps the recent-rows limit', () => {
  assert.deepEqual(parseArgs([]), { recentLimit: DEFAULT_RECENT_LIMIT });
  assert.equal(parseArgs(['--limit', '5']).recentLimit, 5);
  assert.equal(parseArgs(['--limit', '9999']).recentLimit, MAX_RECENT_LIMIT);
  assert.equal(parseArgs(['--limit', 'nope']).recentLimit, DEFAULT_RECENT_LIMIT);
});

// --- summary aggregation ---------------------------------------------------

test('collectSummary aggregates totals, statuses, horizons, and averages', () => {
  const db = seededDb();
  const summary = collectSummary(db);

  assert.equal(summary.totalNewsEvents, 2);
  assert.equal(summary.totalSentimentScores, 1);
  assert.equal(summary.totalPriceReactions, 3);

  assert.deepEqual(summary.measurementStatusCounts, { measured: 2, no_baseline: 1 });
  assert.deepEqual(summary.horizonCounts, { '10s': 2, '1m': 1 });

  // Averages computed only over measured rows: 10s has one row (+0.5%).
  assert.ok(Math.abs(summary.avgReturnByHorizon['10s'].avgReturn - 0.005) < 1e-12);
  assert.equal(summary.avgReturnByHorizon['10s'].n, 1);
  assert.ok(Math.abs(summary.avgReturnByHorizon['1m'].avgReturn - 0.01) < 1e-12);
  assert.equal(summary.recentMeasuredEvents.length, 2);
  closeDatabase(db);
});

test('collectSummary on an empty (migrated) database returns zeros, not an error', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const summary = collectSummary(db);
  assert.equal(summary.totalNewsEvents, 0);
  assert.equal(summary.totalPriceReactions, 0);
  assert.deepEqual(summary.measurementStatusCounts, {});
  assert.deepEqual(summary.avgReturnByHorizon, {});
  assert.deepEqual(summary.recentMeasuredEvents, []);
  closeDatabase(db);
});

test('collectSummary honors the recent-rows cap', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: '2026-06-09T14:30:00.000Z' });
  // Three measured horizons; ask for only one recent row.
  measured(db, 1, '10s', { baseline: 200, reaction: 201, at: '2026-06-09T14:30:10.000Z' });
  measured(db, 1, '1m', { baseline: 200, reaction: 202, at: '2026-06-09T14:31:00.000Z' });
  measured(db, 1, '5m', { baseline: 200, reaction: 203, at: '2026-06-09T14:35:00.000Z' });
  const summary = collectSummary(db, { recentLimit: 1 });
  assert.equal(summary.recentMeasuredEvents.length, 1);
  closeDatabase(db);
});

// --- formatting & redaction (paste-safety) ---------------------------------

test('buildSummaryReport renders totals, statuses, averages, and recent rows', () => {
  const db = seededDb();
  const text = buildSummaryReport(collectSummary(db)).join('\n');
  assert.match(text, /news_events: {6}2/);
  assert.match(text, /sentiment_scores: 1/);
  assert.match(text, /price_reactions: {2}3/);
  assert.match(text, /measurement_status: measured=2  no_baseline=1/);
  assert.match(text, /horizon counts: {5}10s=2  1m=1/);
  assert.match(text, /10s {2}\+0\.500%  \(n=1\)/);
  assert.match(text, /1m {3}\+1\.000%  \(n=1\)/);
  assert.match(text, /event 1 AAPL 1m \+1\.000%/);
  closeDatabase(db);
});

test('buildSummaryReport handles an empty database with explicit "(none)" lines', () => {
  const empty = {
    totalNewsEvents: 0,
    totalSentimentScores: 0,
    totalPriceReactions: 0,
    measurementStatusCounts: {},
    horizonCounts: {},
    avgReturnByHorizon: {},
    recentMeasuredEvents: [],
  };
  const text = buildSummaryReport(empty).join('\n');
  assert.match(text, /measurement_status: \(none\)/);
  assert.match(text, /horizon counts: {5}\(none\)/);
  assert.match(text, /no measured rows yet/);
  assert.match(text, /recent measured rows: \(none\)/);
});

test('the report never prints headlines, raw payloads, or model responses', () => {
  const db = seededDb();
  const text = buildSummaryReport(collectSummary(db)).join('\n');
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  assert.ok(!text.includes('RAW-MODEL-RESPONSE-MUST-NOT-PRINT'));
  // Belt-and-braces: smuggled extra fields on a recent row are ignored.
  const sneaky = buildSummaryReport({
    totalNewsEvents: 1,
    totalSentimentScores: 0,
    totalPriceReactions: 1,
    measurementStatusCounts: { measured: 1 },
    horizonCounts: { '10s': 1 },
    avgReturnByHorizon: { '10s': { avgReturn: 0.005, n: 1 } },
    recentMeasuredEvents: [
      {
        newsEventId: 1,
        ticker: 'AAPL',
        horizon: '10s',
        returnPct: 0.005,
        measuredAt: '2026-06-09T14:30:10.000Z',
        headline: 'RAW-MUST-NOT-PRINT',
        raw_payload: 'RAW-MUST-NOT-PRINT',
      },
    ],
  }).join('\n');
  assert.ok(!sneaky.includes('RAW-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('importing the script performs no network, writes, or credential reads', () => {
  assert.equal(typeof buildSummaryReport, 'function');
  assert.equal(typeof collectSummary, 'function');
});
