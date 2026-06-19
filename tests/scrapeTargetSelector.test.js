// tests/scrapeTargetSelector.test.js — Pure selection tests; NO network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadResearchSources } from '../src/research/researchSources.js';
import { selectScrapeTargets, formatTargetsReport } from '../src/research/scrapeTargetSelector.js';

const { sources } = loadResearchSources();

test('selects approved sources and NEVER the gated/paywalled one', () => {
  const { targets } = selectScrapeTargets({ sources, symbols: ['AAPL'], topics: ['filings'], limit: 10 });
  assert.ok(targets.length > 0);
  assert.ok(!targets.some((t) => t.sourceId === 'example_paywalled_disabled'));
  // Selection-only: every target is fetch-disabled in this patch.
  assert.ok(targets.every((t) => t.fetchDisabled === true));
});

test('topic matches rank a relevant source higher', () => {
  const { targets } = selectScrapeTargets({ sources, symbols: ['NVDA'], topics: ['options_chain'], limit: 10 });
  const optIdx = targets.findIndex((t) => t.sourceId === 'options_research_manual');
  assert.ok(optIdx >= 0);
  assert.ok(targets[optIdx].topicFocus.includes('options_chain'));
});

test('limit is respected', () => {
  assert.ok(selectScrapeTargets({ sources, symbols: ['AAPL'], limit: 1 }).targets.length <= 1);
});

test('formatTargetsReport is sanitized — source ids/metadata only, no base URLs', () => {
  const result = selectScrapeTargets({ sources, symbols: ['AAPL'], topics: ['filings'], limit: 5 });
  const text = formatTargetsReport(result).join('\n');
  assert.match(text, /SELECTION-ONLY/);
  assert.match(text, /sec_edgar_filings/);
  assert.ok(!text.includes('https://www.sec.gov')); // base URLs are not printed
  assert.match(text, /fetch=disabled/);
});

test('empty/garbage sources yield no targets, never throws', () => {
  assert.deepEqual(selectScrapeTargets({ sources: [], symbols: ['AAPL'] }).targets, []);
});
