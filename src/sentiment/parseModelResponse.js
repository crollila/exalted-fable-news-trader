// src/sentiment/parseModelResponse.js — Parser/validator for model output.
//
// Pure function, no I/O, no model calls. Converts raw model response text
// into a ClassificationResult. Never throws on bad MODEL output — every
// failure mode becomes a parserStatus (plan §6). It DOES throw on caller
// bugs (missing promptVersion/modelName), because those break backtest
// reproducibility and must fail loudly in development, not silently in data.

import {
  NEWS_TYPES,
  PARSER_STATUS,
  DIRECTIONS,
  TIME_HORIZONS,
} from './classifierContract.js';

// Required fields the model must supply (plan §4). Optional: time_horizon,
// affected_symbols, rationale.
const REQUIRED_FIELDS = ['news_type', 'sentiment_score', 'impact_score', 'confidence', 'direction'];

const RANGES = {
  sentiment_score: [-1, 1],
  impact_score: [0, 1],
  confidence: [0, 1],
};

function result(promptVersion, modelName, parserStatus, output, rawModelResponse, errors) {
  return { promptVersion, modelName, parserStatus, output, rawModelResponse, errors };
}

/**
 * Parse raw model response text into a ClassificationResult.
 *
 * @param {string} rawText  the unmodified model output (always preserved)
 * @param {object} options
 * @param {string} options.promptVersion  REQUIRED — throws if absent
 * @param {string} options.modelName      REQUIRED — throws if absent
 * @returns {import('./classifierContract.js').ClassificationResult}
 */
export function parseModelResponse(rawText, { promptVersion, modelName } = {}) {
  // Caller bugs fail loudly: scores without a prompt version are useless
  // for backtests and must never enter the dataset.
  if (typeof promptVersion !== 'string' || promptVersion.trim() === '') {
    throw new Error('parseModelResponse: promptVersion is required');
  }
  if (typeof modelName !== 'string' || modelName.trim() === '') {
    throw new Error('parseModelResponse: modelName is required');
  }

  const raw = typeof rawText === 'string' ? rawText : String(rawText ?? '');

  // 1. JSON parse
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return result(promptVersion, modelName, PARSER_STATUS.MALFORMED_JSON, null, raw, [
      `JSON parse failed: ${err.message}`,
    ]);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return result(promptVersion, modelName, PARSER_STATUS.MALFORMED_JSON, null, raw, [
      'model output is valid JSON but not an object',
    ]);
  }

  // 2. Required fields
  const missing = REQUIRED_FIELDS.filter((f) => data[f] === undefined || data[f] === null);
  if (missing.length > 0) {
    return result(promptVersion, modelName, PARSER_STATUS.MISSING_REQUIRED_FIELD, null, raw, [
      `missing required field(s): ${missing.join(', ')}`,
    ]);
  }

  // 3. Score ranges (numeric and in range)
  const rangeErrors = [];
  for (const [field, [lo, hi]] of Object.entries(RANGES)) {
    const value = data[field];
    if (typeof value !== 'number' || Number.isNaN(value) || value < lo || value > hi) {
      rangeErrors.push(`${field}=${JSON.stringify(value)} outside [${lo}, ${hi}]`);
    }
  }
  if (rangeErrors.length > 0) {
    return result(promptVersion, modelName, PARSER_STATUS.INVALID_SCORE_RANGE, null, raw, rangeErrors);
  }

  // 4. Enums — unknown values fall back to safe defaults (status: fallback_used)
  const errors = [];
  let fallback = false;

  let newsType = data.news_type;
  if (!NEWS_TYPES.includes(newsType)) {
    errors.push(`unknown news_type "${newsType}" — fell back to "other"`);
    newsType = 'other';
    fallback = true;
  }
  let direction = data.direction;
  if (!DIRECTIONS.includes(direction)) {
    errors.push(`unknown direction "${direction}" — fell back to "unclear"`);
    direction = 'unclear';
    fallback = true;
  }
  let timeHorizon = data.time_horizon ?? null;
  if (timeHorizon !== null && !TIME_HORIZONS.includes(timeHorizon)) {
    errors.push(`unknown time_horizon "${timeHorizon}" — fell back to null`);
    timeHorizon = null;
    fallback = true;
  }

  const affectedSymbols = Array.isArray(data.affected_symbols)
    ? data.affected_symbols
        .filter((s) => typeof s === 'string' && s.trim() !== '')
        .map((s) => s.trim().toUpperCase())
    : [];

  const output = {
    newsType,
    sentimentScore: data.sentiment_score,
    impactScore: data.impact_score,
    confidence: data.confidence,
    direction,
    timeHorizon,
    affectedSymbols,
    rationale: typeof data.rationale === 'string' && data.rationale !== '' ? data.rationale : null,
  };

  return result(
    promptVersion,
    modelName,
    fallback ? PARSER_STATUS.FALLBACK_USED : PARSER_STATUS.PARSED,
    output,
    raw,
    errors
  );
}
