// tests/fixtures/modelResponses.js — Canned raw "model" responses for parser
// and classifier tests. Strings only; no model involved anywhere.

export const VALID_RESPONSE = JSON.stringify({
  news_type: 'earnings',
  sentiment_score: 0.62,
  impact_score: 0.7,
  confidence: 0.85,
  direction: 'up',
  time_horizon: 'intraday',
  affected_symbols: ['aapl', ' msft '],
  rationale: 'Strong beat with raised guidance.',
});

export const MINIMAL_VALID_RESPONSE = JSON.stringify({
  news_type: 'other',
  sentiment_score: 0,
  impact_score: 0.1,
  confidence: 0.4,
  direction: 'unclear',
  // no time_horizon, affected_symbols, or rationale — all optional
});

export const MALFORMED_JSON_RESPONSE = '{"news_type": "earnings", "sentiment_score": 0.6,';

export const NON_OBJECT_JSON_RESPONSE = '["not", "an", "object"]';

export const MISSING_FIELD_RESPONSE = JSON.stringify({
  news_type: 'earnings',
  sentiment_score: 0.5,
  // impact_score missing
  confidence: 0.8,
  direction: 'up',
});

export const OUT_OF_RANGE_RESPONSE = JSON.stringify({
  news_type: 'earnings',
  sentiment_score: 1.7, // > 1.0
  impact_score: 0.5,
  confidence: 0.9,
  direction: 'up',
});

export const NON_NUMERIC_SCORE_RESPONSE = JSON.stringify({
  news_type: 'earnings',
  sentiment_score: 'very positive', // not a number
  impact_score: 0.5,
  confidence: 0.9,
  direction: 'up',
});

export const UNKNOWN_ENUM_RESPONSE = JSON.stringify({
  news_type: 'meme_stock_frenzy', // not in taxonomy v1
  sentiment_score: 0.4,
  impact_score: 0.6,
  confidence: 0.7,
  direction: 'sideways', // not a valid direction
});
