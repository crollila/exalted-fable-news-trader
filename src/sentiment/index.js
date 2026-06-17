// src/sentiment/index.js — Public surface of the sentiment module (Phase 3).
//
// Fixture/injection-only: no model calls, no API keys, no writes to
// sentiment_scores. See docs/sentiment-classification-plan.md.

export {
  NEWS_TYPES,
  PARSER_STATUS,
  DIRECTIONS,
  TIME_HORIZONS,
  validateClassifier,
  assertClassificationResult,
} from './classifierContract.js';
export { parseModelResponse } from './parseModelResponse.js';
export { createFixtureClassifier } from './fixtureClassifier.js';
export {
  createModelClassifier,
  buildSystemPrompt,
  buildUserPrompt,
  MODEL_PROMPT_VERSION,
} from './modelClassifier.js';
