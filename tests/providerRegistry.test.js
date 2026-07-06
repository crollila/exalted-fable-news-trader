// tests/providerRegistry.test.js — Registry-wide guarantees for all real
// provider adapters. Catches a forgotten export, a renamed provider, or a
// contract drift the moment it happens. No network, no keys.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import * as providers from '../src/providers/index.js';
import { assertNormalizedNewsEvent, validateProvider } from '../src/providers/newsProvider.js';
import { PROVIDER_REGISTRY, fixtureProvider } from './helpers/providerTestHelpers.js';

const EXPECTED_FACTORY_EXPORTS = [
  'createMockProvider',
  'createAlpacaNewsProvider',
  'createBenzingaNewsProvider',
];

const EXPECTED_NAMES = ['alpaca', 'benzinga'];

test('all planned provider factories are exported from src/providers/index.js', () => {
  for (const name of EXPECTED_FACTORY_EXPORTS) {
    assert.equal(typeof providers[name], 'function', `missing export: ${name}`);
  }
  // Contract utilities are part of the public surface too.
  assert.equal(typeof providers.normalizeNewsEvent, 'function');
  assert.equal(typeof providers.validateProvider, 'function');
  assert.equal(typeof providers.assertNormalizedNewsEvent, 'function');
});

test('registry covers every planned real provider exactly once', () => {
  assert.deepEqual(
    PROVIDER_REGISTRY.map((e) => e.expectedName).sort(),
    [...EXPECTED_NAMES].sort()
  );
});

test('every provider is contract-valid with a stable name', () => {
  for (const entry of PROVIDER_REGISTRY) {
    const provider = fixtureProvider(entry);
    validateProvider(provider);
    assert.equal(provider.name, entry.expectedName);
  }
});

test('provider names are unique', () => {
  const names = PROVIDER_REGISTRY.map((entry) => fixtureProvider(entry).name);
  assert.equal(new Set(names).size, names.length, `duplicate provider names in: ${names}`);
});

test('injected fixture transports return normalized events for every provider', async () => {
  for (const entry of PROVIDER_REGISTRY) {
    const events = await fixtureProvider(entry).fetchNews();
    assert.ok(events.length > 0, `${entry.expectedName}: fixtures produced no events`);
    for (const event of events) {
      assertNormalizedNewsEvent(event);
      assert.equal(event.provider, entry.expectedName);
    }
  }
});

test('every no-transport default rejects and never touches the network', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network call attempted by a provider default');
  };
  try {
    for (const { factory, expectedName } of PROVIDER_REGISTRY) {
      const provider = factory(); // no transport injected
      validateProvider(provider); // shape is valid even without a transport
      await assert.rejects(
        () => provider.fetchNews(),
        /no transport configured/i,
        `${expectedName}: default fetchNews should reject`
      );
    }
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
