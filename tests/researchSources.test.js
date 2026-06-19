// tests/researchSources.test.js — Loads the committed example allow-list (real
// fs read; NO network) and verifies validation + the strict URL allow-list.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadResearchSources, validateSource, isSelectable, isFetchAllowed, isAllowedUrl,
} from '../src/research/researchSources.js';

const { sources } = loadResearchSources(); // real committed config/research-sources.example.json

test('the example allow-list loads and validates', () => {
  assert.ok(sources.length >= 4);
  assert.ok(sources.every((s) => typeof s.sourceId === 'string' && s.sourceId));
  assert.ok(sources.every((s) => Number.isFinite(s.rateLimitPerHour))); // rate limits present
});

test('validateSource rejects missing id / invalid type', () => {
  const warnings = [];
  assert.equal(validateSource({ type: 'rss', scrape_mode: 'metadata_only' }, warnings), null); // no id
  assert.equal(validateSource({ source_id: 'x', type: 'bogus', scrape_mode: 'metadata_only' }, warnings), null);
});

test('disabled / paywalled / auth-required sources are NOT selectable and NEVER fetchable', () => {
  const gated = sources.find((s) => s.sourceId === 'example_paywalled_disabled');
  assert.ok(gated);
  assert.equal(isSelectable(gated), false);
  assert.equal(isSelectable(gated, { includeDisabled: true }), false); // still gated
  assert.equal(isFetchAllowed(gated), false);
});

test('no example source is fetch-allowed (selection-only patch)', () => {
  assert.ok(sources.every((s) => !isFetchAllowed(s)));
});

test('isAllowedUrl accepts ONLY allow-listed origins+paths over https', () => {
  // SEC source: base https://www.sec.gov, allowed /cgi-bin/browse-edgar.
  assert.equal(isAllowedUrl('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany', sources), true);
  // Not under an allowed path:
  assert.equal(isAllowedUrl('https://www.sec.gov/some/other/path', sources), false);
  // Arbitrary origin:
  assert.equal(isAllowedUrl('https://evil.example.net/anything', sources), false);
  // http (not https):
  assert.equal(isAllowedUrl('http://www.sec.gov/cgi-bin/browse-edgar', sources), false);
  // The disabled/paywalled example.com source must never authorize a URL:
  assert.equal(isAllowedUrl('https://example.com/', sources), false);
  // Garbage:
  assert.equal(isAllowedUrl('not a url', sources), false);
});
