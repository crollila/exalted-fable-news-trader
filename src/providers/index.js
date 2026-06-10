// src/providers/index.js — Public surface of the providers module.
//
// Real providers (Alpaca News, Benzinga, Polygon/Massive, Alpha Vantage)
// will be added here in later phases.

export { normalizeNewsEvent, toUtcIso, upperOrNull, normalizeSymbols } from './normalize.js';
export { assertNormalizedNewsEvent, validateProvider } from './newsProvider.js';
export { createMockProvider } from './mockProvider.js';
