// src/sentiment/classifierContract.js — The classifier contract (Phase 3).
//
// Mirrors the provider contract pattern: JSDoc typedefs plus runtime
// validation helpers. NO model calls live here or anywhere in Phase 3 step 1;
// classifiers are fixture/injection-only until a real model client is
// explicitly approved (see docs/sentiment-classification-plan.md).

/** Taxonomy v1 — versioned with the prompt; revise via new version only. */
export const NEWS_TYPES = Object.freeze([
  'earnings',
  'guidance',
  'merger_acquisition',
  'analyst_rating',
  'fda_regulatory',
  'legal_lawsuit',
  'management_change',
  'financing_offering',
  'contract_partnership',
  'product_launch',
  'macro_sector',
  'unusual_market_activity',
  'other',
]);

/** Parser outcome labels (docs/sentiment-classification-plan.md §6). */
export const PARSER_STATUS = Object.freeze({
  PARSED: 'parsed',
  MALFORMED_JSON: 'malformed_json',
  MISSING_REQUIRED_FIELD: 'missing_required_field',
  INVALID_SCORE_RANGE: 'invalid_score_range',
  MODEL_ERROR: 'model_error',
  FALLBACK_USED: 'fallback_used',
});

export const DIRECTIONS = Object.freeze(['up', 'down', 'unclear']);
export const TIME_HORIZONS = Object.freeze(['intraday', 'multiday', 'long_term']);

/**
 * @typedef {object} ClassificationOutput
 * Validated classifier output (plan §4). Present only when parserStatus is
 * 'parsed' or 'fallback_used'.
 * @property {string} newsType          one of NEWS_TYPES
 * @property {number} sentimentScore    -1.0 .. +1.0
 * @property {number} impactScore       0.0 .. 1.0
 * @property {number} confidence        0.0 .. 1.0
 * @property {string} direction         one of DIRECTIONS
 * @property {string|null} timeHorizon  one of TIME_HORIZONS or null
 * @property {string[]} affectedSymbols uppercase tickers
 * @property {string|null} rationale
 */

/**
 * @typedef {object} ClassificationResult
 * What a classifier returns per event. The raw model response is ALWAYS
 * preserved, including on failure (plan §6: store, don't discard).
 * @property {string} promptVersion     required, e.g. 'sentiment_v1'
 * @property {string} modelName         required, e.g. 'fixture'
 * @property {string} parserStatus      one of PARSER_STATUS values
 * @property {ClassificationOutput|null} output
 * @property {string} rawModelResponse  unmodified model output text
 * @property {string[]} errors          human-readable failure notes
 */

/**
 * @typedef {object} Classifier
 * @property {string} name            stable identifier, e.g. 'fixture'
 * @property {string} promptVersion   required for reproducibility
 * @property {string} modelName
 * @property {(event: import('../providers/newsProvider.js').NormalizedNewsEvent)
 *   => Promise<ClassificationResult>} classifyEvent
 *   Must NEVER throw on bad model output — failures are encoded in
 *   parserStatus so classification can never block ingestion.
 */

/** Throw if an object does not satisfy the Classifier contract shape. */
export function validateClassifier(classifier) {
  if (!classifier || typeof classifier !== 'object') {
    throw new Error('Classifier must be an object');
  }
  if (typeof classifier.name !== 'string' || classifier.name.trim() === '') {
    throw new Error('Classifier.name must be a non-empty string');
  }
  if (typeof classifier.promptVersion !== 'string' || classifier.promptVersion.trim() === '') {
    throw new Error('Classifier.promptVersion must be a non-empty string');
  }
  if (typeof classifier.modelName !== 'string' || classifier.modelName.trim() === '') {
    throw new Error('Classifier.modelName must be a non-empty string');
  }
  if (typeof classifier.classifyEvent !== 'function') {
    throw new Error('Classifier.classifyEvent must be a function');
  }
  return classifier;
}

/** Throw if an object is not a structurally valid ClassificationResult. */
export function assertClassificationResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('ClassificationResult must be an object');
  }
  if (typeof result.promptVersion !== 'string' || result.promptVersion === '') {
    throw new Error('ClassificationResult.promptVersion is required');
  }
  if (typeof result.modelName !== 'string' || result.modelName === '') {
    throw new Error('ClassificationResult.modelName is required');
  }
  if (!Object.values(PARSER_STATUS).includes(result.parserStatus)) {
    throw new Error(`ClassificationResult.parserStatus invalid: ${result.parserStatus}`);
  }
  if (typeof result.rawModelResponse !== 'string') {
    throw new Error('ClassificationResult.rawModelResponse must be a string (always preserved)');
  }
  if (!Array.isArray(result.errors)) {
    throw new Error('ClassificationResult.errors must be an array');
  }
  const hasOutput = result.output !== null && result.output !== undefined;
  const expectsOutput =
    result.parserStatus === PARSER_STATUS.PARSED ||
    result.parserStatus === PARSER_STATUS.FALLBACK_USED;
  if (expectsOutput && !hasOutput) {
    throw new Error(`ClassificationResult.output required when parserStatus=${result.parserStatus}`);
  }
  if (!expectsOutput && hasOutput) {
    throw new Error(`ClassificationResult.output must be null when parserStatus=${result.parserStatus}`);
  }
  return result;
}
