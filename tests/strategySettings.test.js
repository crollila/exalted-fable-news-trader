// tests/strategySettings.test.js — Pure tests + a FAKE fs (no real disk, no
// network). Verifies validation/capping, example->runtime override, note
// appending (deduped+capped), and that writes only ever target the data file
// (never .env) and never carry secrets / live-trading.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStrategySettings, loadStrategySettings, appendNotes, writeStrategySettings,
  buildSettingsFile, DEFAULT_SETTINGS, NOTES_CAP,
} from '../src/config/strategySettings.js';

function fakeFs(files = {}) {
  return {
    files,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFileSync: (p, content) => { files[p] = content; },
    mkdirSync: () => {},
  };
}
const EX = '/x/config/strategy-settings.example.json';
const RT = '/x/data/strategy-settings.json';

test('validateStrategySettings caps invalid values and drops unknown/forbidden keys', () => {
  const { settings, warnings } = validateStrategySettings({
    max_order_notional: -5, interval_minutes: 1, confidence_threshold: 2,
    sizing_min_comparable_sample_size: 1,
    sizing_cold_start_target_weight: 9,
    sizing_max_target_weight: 9,
    symbols: ['aapl', 'aapl', 'msft'],
    UNKNOWN_KEY: 'x', ALPACA_API_SECRET_KEY: 'leak', LIVE_TRADING_ENABLED: 'true',
  });
  assert.equal(settings.max_order_notional, DEFAULT_SETTINGS.max_order_notional); // invalid -> default
  assert.equal(settings.interval_minutes, 5); // floored to the loop minimum
  assert.equal(settings.confidence_threshold, 1); // clamped to [0,1]
  assert.equal(settings.sizing_min_comparable_sample_size, 3); // floored
  assert.equal(settings.sizing_cold_start_target_weight, 0.01); // capped beneath hard risk caps
  assert.equal(settings.sizing_max_target_weight, 0.01);
  assert.deepEqual(settings.symbols, ['AAPL', 'MSFT']); // upper + dedup
  assert.ok(!('UNKNOWN_KEY' in settings));
  assert.ok(!('ALPACA_API_SECRET_KEY' in settings)); // forbidden secret-like key dropped
  assert.ok(!('LIVE_TRADING_ENABLED' in settings)); // never present
  assert.ok(warnings.some((w) => /forbidden/.test(w)));
});

test('loadStrategySettings: example used when runtime missing; runtime overrides example', () => {
  const exContent = JSON.stringify({ settings: { max_order_notional: 500 }, notes: [] });
  const fsEx = fakeFs({ [EX]: exContent });
  const a = loadStrategySettings({ runtimePath: RT, examplePath: EX, fsImpl: fsEx });
  assert.equal(a.source, 'example');
  assert.equal(a.settings.max_order_notional, 500);

  const fsRt = fakeFs({ [EX]: exContent, [RT]: JSON.stringify({ settings: { max_order_notional: 300 }, notes: [{ field: 'x' }] }) });
  const b = loadStrategySettings({ runtimePath: RT, examplePath: EX, fsImpl: fsRt });
  assert.equal(b.source, 'runtime');
  assert.equal(b.settings.max_order_notional, 300);
  assert.equal(b.notes.length, 1);
});

test('loadStrategySettings falls back to defaults when no file exists', () => {
  const r = loadStrategySettings({ runtimePath: RT, examplePath: EX, fsImpl: fakeFs({}) });
  assert.equal(r.source, 'defaults');
  assert.equal(r.settings.max_order_notional, DEFAULT_SETTINGS.max_order_notional);
});

test('appendNotes de-duplicates identical entries and caps the total', () => {
  const a = appendNotes([{ field: 'x', to: 1, reason: 'r' }], [{ field: 'x', to: 1, reason: 'r' }]);
  assert.equal(a.length, 1); // identical note not duplicated
  const many = Array.from({ length: NOTES_CAP + 10 }, (_, i) => ({ field: `f${i}`, to: i, reason: 'r' }));
  assert.equal(appendNotes([], many).length, NOTES_CAP); // capped
});

test('writeStrategySettings writes ONLY the data file and refuses .env', () => {
  const fsi = fakeFs({});
  const { path, file } = writeStrategySettings({ path: RT, settings: { max_order_notional: 400 }, notes: [{ field: 'max_order_notional', to: 400 }], fsImpl: fsi, now: () => '2026-06-18T00:00:00.000Z' });
  assert.equal(path, RT);
  assert.ok(RT in fsi.files);
  const parsed = JSON.parse(fsi.files[RT]);
  assert.equal(parsed.settings.max_order_notional, 400);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.notes.length, 1);
  // Never writes .env.
  assert.throws(() => writeStrategySettings({ path: '/x/.env', settings: {}, fsImpl: fsi }), /refusing to write a \.env/);
  assert.ok(!('/x/.env' in fsi.files));
});

test('buildSettingsFile re-validates settings and never carries secrets', () => {
  const file = buildSettingsFile({ settings: { max_order_notional: 999999999, DISCORD_WEBHOOK_URL: 'leak' }, notes: [] }, { now: () => 'T' });
  assert.ok(!('DISCORD_WEBHOOK_URL' in file.settings));
  assert.ok(file.settings.max_order_notional <= 100000); // capped
  assert.equal(file.settings.sizing_min_comparable_sample_size, DEFAULT_SETTINGS.sizing_min_comparable_sample_size);
});
