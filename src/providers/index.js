// src/providers/index.js — Public surface of the providers module.
//
// All four planned provider adapters (Alpaca, Benzinga, Alpha Vantage,
// Polygon/Massive) now exist as non-network skeletons; real transports are
// added in later phases via injection or explicit configuration.

export { normalizeNewsEvent, toUtcIso, upperOrNull, normalizeSymbols } from './normalize.js';
export { assertNormalizedNewsEvent, validateProvider } from './newsProvider.js';
export { createMockProvider } from './mockProvider.js';
export { createAlpacaNewsProvider } from './alpacaNewsProvider.js';
export { createAlpacaNewsHttpTransport } from './alpacaNewsHttpTransport.js';
export { createBenzingaNewsProvider } from './benzingaNewsProvider.js';
export { createBenzingaNewsHttpTransport } from './benzingaNewsHttpTransport.js';
export { createAlphaVantageNewsProvider } from './alphaVantageNewsProvider.js';
export { createPolygonNewsProvider } from './polygonNewsProvider.js';
