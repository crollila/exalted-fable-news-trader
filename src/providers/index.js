// src/providers/index.js — Public surface of the providers module.
//
// Real transports for Alpaca, Benzinga, Alpha Vantage (and later
// Polygon/Massive) are added in later phases; adapters here are non-network
// until a transport is injected or configured.

export { normalizeNewsEvent, toUtcIso, upperOrNull, normalizeSymbols } from './normalize.js';
export { assertNormalizedNewsEvent, validateProvider } from './newsProvider.js';
export { createMockProvider } from './mockProvider.js';
export { createAlpacaNewsProvider } from './alpacaNewsProvider.js';
export { createBenzingaNewsProvider } from './benzingaNewsProvider.js';
export { createAlphaVantageNewsProvider } from './alphaVantageNewsProvider.js';
