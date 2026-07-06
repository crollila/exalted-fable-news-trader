// tests/helpers/providerTestHelpers.js — Shared registry of real provider
// adapters for cross-provider tests. Minimal by intent: a new provider needs
// one entry here to be covered by every registry-wide test.

import {
  createAlpacaNewsProvider,
  createBenzingaNewsProvider,
} from '../../src/providers/index.js';
import { ALPACA_NEWS_FIXTURES } from '../fixtures/alpacaNews.js';
import { BENZINGA_NEWS_FIXTURES } from '../fixtures/benzingaNews.js';

/**
 * One entry per real (non-mock) provider adapter.
 * @type {{ expectedName: string, factory: Function, fixtures: object[] }[]}
 */
export const PROVIDER_REGISTRY = [
  { expectedName: 'alpaca', factory: createAlpacaNewsProvider, fixtures: ALPACA_NEWS_FIXTURES },
  { expectedName: 'benzinga', factory: createBenzingaNewsProvider, fixtures: BENZINGA_NEWS_FIXTURES },
];

/** Build a provider wired to its static fixtures (no network). */
export function fixtureProvider({ factory, fixtures }) {
  return factory({ fetchRawNews: async () => fixtures });
}
