// src/providers/index.js — Public surface of the providers module.
//
// Alpaca (primary, real HTTP transport) and Benzinga (optional plug-in,
// transport injected) implement the pluggable NewsProvider contract; new
// sources are added by implementing the same contract.

export { normalizeNewsEvent, toUtcIso, upperOrNull, normalizeSymbols } from './normalize.js';
export { assertNormalizedNewsEvent, validateProvider } from './newsProvider.js';
export { createMockProvider } from './mockProvider.js';
export { createAlpacaNewsProvider } from './alpacaNewsProvider.js';
export { createBenzingaNewsProvider } from './benzingaNewsProvider.js';
