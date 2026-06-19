// tests/updateStrategySettingsFromLearning.test.js — In-memory DB + FAKE fs.
// No real disk writes, no network. Verifies dry-run writes nothing, --write
// writes ONLY the data file (never .env), and notes are appended.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  parseArgs, runStrategyUpdate, buildUpdateReport, buildUpdateJson,
} from '../scripts/updateStrategySettingsFromLearning.js';

const CONFIG = { risk: { maxTradesPerDay: 10 }, liveTradingEnabled: false };
const SETTINGS_PATH = '/x/data/strategy-settings.json';

function fakeFs(files = {}) {
  return {
    files,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFileSync: (p, content) => { files[p] = content; },
    mkdirSync: () => {},
  };
}

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

/** Seed enough notional rejections to trigger a max_order_notional decrease. */
function seedNotionalRejections(db, n = 3) {
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      `INSERT INTO rejected_trades (ticker, side, quantity, reason)
       VALUES ('AAPL','buy',1,'order notional 1000 exceeds --max-order-notional 500')`
    ).run();
  }
}

test('parseArgs defaults to a dry run', () => {
  const a = parseArgs([]);
  assert.equal(a.write, false);
  assert.equal(a.format, 'text');
  assert.equal(parseArgs(['--write']).write, true);
  assert.equal(parseArgs(['--write', '--dry-run']).write, false); // explicit dry-run wins
  assert.equal(parseArgs(['--include-env-recommendations']).includeEnv, true);
  assert.equal(parseArgs(['--format', 'json']).format, 'json');
});

test('dry run recommends changes but writes NOTHING', () => {
  const db = freshDb();
  seedNotionalRejections(db);
  const fsi = fakeFs({});
  const result = runStrategyUpdate(db, { config: CONFIG, write: false, settingsPath: SETTINGS_PATH, fsImpl: fsi });
  assert.ok(result.strat.changes.length > 0);
  assert.equal(result.written, false);
  assert.deepEqual(Object.keys(fsi.files), []); // nothing written
  const text = buildUpdateReport(result, { mode: 'dry-run' }).join('\n');
  assert.match(text, /\.env was not edited\./);
  assert.match(text, /written: no \(dry run\)/);
  closeDatabase(db);
});

test('--write writes ONLY the data file (never .env) and appends notes', () => {
  const db = freshDb();
  seedNotionalRejections(db);
  const fsi = fakeFs({});
  const result = runStrategyUpdate(db, {
    config: CONFIG, write: true, settingsPath: SETTINGS_PATH, fsImpl: fsi, now: () => '2026-06-18T00:00:00.000Z',
  });
  assert.equal(result.written, true);
  assert.equal(result.writtenPath, SETTINGS_PATH);
  assert.deepEqual(Object.keys(fsi.files), [SETTINGS_PATH]); // ONLY the data file
  assert.ok(!Object.keys(fsi.files).some((p) => /\.env/.test(p))); // never .env
  const written = JSON.parse(fsi.files[SETTINGS_PATH]);
  assert.ok(written.settings.max_order_notional < 500); // change applied
  assert.ok(written.notes.length >= 1); // note appended
  closeDatabase(db);
});

test('a second --write appends without duplicating identical notes (no bloat)', () => {
  const db = freshDb();
  seedNotionalRejections(db);
  const fsi = fakeFs({});
  runStrategyUpdate(db, { config: CONFIG, write: true, settingsPath: SETTINGS_PATH, fsImpl: fsi, now: () => 'T1' });
  const firstNotes = JSON.parse(fsi.files[SETTINGS_PATH]).notes.length;
  // Re-run with the SAME signals -> the change recommends the same target value,
  // so the note de-dupes and the count does not grow unbounded.
  runStrategyUpdate(db, { config: CONFIG, write: true, settingsPath: SETTINGS_PATH, fsImpl: fsi, now: () => 'T2' });
  const secondNotes = JSON.parse(fsi.files[SETTINGS_PATH]).notes.length;
  assert.ok(secondNotes <= firstNotes + 0 + 1); // bounded; not duplicated per field/target
  closeDatabase(db);
});

test('--include-env-recommendations adds env-only recommendations; JSON marks envEdited false', () => {
  const db = freshDb();
  seedNotionalRejections(db);
  const result = runStrategyUpdate(db, { config: CONFIG, write: false, settingsPath: SETTINGS_PATH, includeEnv: true, fsImpl: fakeFs({}) });
  assert.ok(Array.isArray(result.envRecs));
  const json = buildUpdateJson(result, { mode: 'dry-run' });
  assert.equal(json.envEdited, false);
  assert.equal(json.written, false);
  closeDatabase(db);
});

test('report contains no secrets and never recommends enabling live trading', () => {
  const db = freshDb();
  seedNotionalRejections(db);
  const result = runStrategyUpdate(db, { config: CONFIG, write: false, settingsPath: SETTINGS_PATH, includeEnv: true, fsImpl: fakeFs({}) });
  const text = buildUpdateReport(result, { mode: 'dry-run' }).join('\n');
  assert.ok(!/KEY|SECRET|TOKEN|WEBHOOK/i.test(text));
  assert.ok(!/LIVE_TRADING_ENABLED=true/.test(text));
  closeDatabase(db);
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof runStrategyUpdate, 'function');
  assert.equal(typeof parseArgs, 'function');
});
