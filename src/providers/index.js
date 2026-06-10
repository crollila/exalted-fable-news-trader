// src/providers/index.js — Public surface of the providers module.
//
// Real transports for Alpaca (and later Benzinga, Polygon/Massive,
// Alpha Vantage) are added in later phases; adapters here are non-network
// until a transport is injected or configured.

export { normalizeNewsEvent, toUtcIso, upperOrNull, normalizeSymbols } from './normalize.js';
export { assertNormalizedNewsEvent, validateProvider } from './newsProvider.js';
export { createMockProvider } from './mockProvider.js';
export { createAlpacaNewsProvider } from './alpacaNewsProvider.js';
