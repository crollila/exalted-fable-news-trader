// src/sentiment/modelClassifier.js — Real model-backed classifier (Phase C).
//
// The first REAL model classifier behind the existing Classifier contract
// (src/sentiment/classifierContract.js). It is a sibling to the fixture
// classifier: same contract, same parser, same storage path — the only
// difference is that the "responder" is a real Anthropic Messages API call
// (raw HTTP via injectable fetch) instead of an injected canned string. The
// project is zero-dependency, so this uses the documented HTTP surface rather
// than an SDK.
//
// Safety regime mirrors the real Alpaca transports (alpacaNewsHttpTransport,
// alpacaTradesPriceSource):
// - DISABLED BY DEFAULT / explicit construction only: createModelClassifier()
//   throws "not configured" without an API key. Nothing here runs at import
//   time, on startup, in schedulers, or in npm test.
// - Credentials come ONLY from config (src/config.js reads process.env;
//   nothing here touches process.env). The key goes into a request header and
//   NOWHERE else — never thrown, logged, returned, or persisted.
// - Errors are sanitized: messages are static text + status codes, defensively
//   redacted so the key can never leak.
// - The HTTP function is injectable; tests inject fakes and never hit the network.
// - classifyEvent NEVER throws on a bad model call (contract): transport/HTTP
//   failures become parserStatus 'model_error'; the raw model text (when
//   present) flows through the EXISTING parseModelResponse UNCHANGED, so
//   malformed/out-of-range/missing-field outcomes are stored as data exactly
//   as for the fixture classifier. The parser contract is not touched.

import { NEWS_TYPES, DIRECTIONS, TIME_HORIZONS } from './classifierContract.js';
import { parseModelResponse } from './parseModelResponse.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';
const ANTHROPIC_VERSION = '2023-06-01';

/** Prompt version for the real model classifier — distinct from manual_v1. */
export const MODEL_PROMPT_VERSION = 'model_v1';

/** Small bounded output; the classifier returns one compact JSON object. */
export const DEFAULT_MAX_TOKENS = 1024;

/** Keep the prompt token-bounded; news bodies can be long. */
const MAX_BODY_CHARS = 2000;

/** Replace any occurrence of the given secrets in text with [redacted]. */
function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Build the system prompt instructing the model to emit ONLY the JSON object
 * the existing parser expects (plan §4 schema). Pure/static — no secrets, no
 * event data. The strict "JSON only" instruction keeps the raw response
 * byte-for-byte parseable, so it can be stored unchanged and parsed by the
 * existing parseModelResponse.
 */
export function buildSystemPrompt() {
  return [
    'You are a financial news classifier for an event-study research system.',
    'Classify the news item and estimate its likely short-term market impact.',
    'Respond with ONLY a single JSON object and nothing else — no prose, no',
    'markdown, no code fences. The object must have exactly these fields:',
    '',
    `- "news_type": one of ${JSON.stringify(NEWS_TYPES)}`,
    '- "sentiment_score": number from -1.0 (very negative) to 1.0 (very positive)',
    '- "impact_score": number from 0.0 (no expected reaction) to 1.0 (large reaction)',
    '- "confidence": number from 0.0 to 1.0 (your own certainty)',
    `- "direction": one of ${JSON.stringify(DIRECTIONS)}`,
    `- "time_horizon": one of ${JSON.stringify(TIME_HORIZONS)} (optional)`,
    '- "affected_symbols": array of uppercase ticker strings (optional)',
    '- "rationale": short string explaining the call (optional)',
    '',
    'Score honestly; use "unclear"/0 when the news is not market-relevant.',
  ].join('\n');
}

/** Whitelisted display text; never used on secrets (none reach this module). */
function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Build the user message text from WHITELISTED news_events row fields only
 * (ticker, headline, body/summary). Never echoes raw_payload, keys, or any
 * other column. Exported for tests (redaction / field-whitelist assertions).
 *
 * @param {object} event  a news_events row (or normalized event)
 * @returns {string}
 */
export function buildUserPrompt(event) {
  const ticker =
    typeof event?.ticker === 'string' && event.ticker.trim() !== ''
      ? event.ticker.trim().toUpperCase()
      : '(unknown)';
  const headline =
    typeof event?.headline === 'string' && event.headline.trim() !== ''
      ? event.headline.trim()
      : '(no headline)';
  const body =
    (typeof event?.body === 'string' && event.body.trim() !== '' && event.body) ||
    (typeof event?.summary === 'string' && event.summary.trim() !== '' && event.summary) ||
    '';
  const lines = [`Ticker: ${ticker}`, `Headline: ${headline}`];
  if (body) lines.push(`Body: ${truncate(body, MAX_BODY_CHARS)}`);
  return lines.join('\n');
}

/** Concatenate the text blocks of an Anthropic Messages response payload. */
function extractText(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * Create a real model-backed classifier.
 *
 * Explicit construction only — this is the single place a live model-call path
 * can come into existence, and only with a configured key.
 *
 * @param {object} config  result of loadConfig(); uses config.model only
 * @param {object} [options]
 * @param {Function} [options.httpFetch]  injected fetch-compatible function
 *   (tests inject fakes; real use defaults to globalThis.fetch)
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]         model id; defaults to config.model.classifierModel
 * @param {string} [options.promptVersion] defaults to MODEL_PROMPT_VERSION
 * @param {number} [options.maxTokens]
 * @returns {import('./classifierContract.js').Classifier}
 * @throws immediately (before any HTTP) if credentials are not configured.
 */
export function createModelClassifier(
  config,
  {
    httpFetch,
    baseUrl = DEFAULT_BASE_URL,
    model,
    promptVersion = MODEL_PROMPT_VERSION,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = {}
) {
  const apiKey = config?.model?.anthropicApiKey;
  if (!apiKey) {
    throw new Error(
      'modelClassifier: not configured — set ANTHROPIC_API_KEY in .env ' +
        '(see .env.example). No model call was made.'
    );
  }
  const modelName = model || config?.model?.classifierModel || DEFAULT_MODEL;
  const secrets = [apiKey];
  const doFetch = httpFetch ?? globalThis.fetch;
  const systemPrompt = buildSystemPrompt();

  /** Build a model_error ClassificationResult (never throws; failures = data). */
  function modelError(message) {
    return {
      promptVersion,
      modelName,
      parserStatus: 'model_error',
      output: null,
      rawModelResponse: '',
      errors: [message],
    };
  }

  /** One Messages API call. Returns raw model text or throws a sanitized error. */
  async function requestCompletion(event) {
    const body = JSON.stringify({
      model: modelName,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildUserPrompt(event) }],
    });

    let response;
    try {
      response = await doFetch(baseUrl, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body,
      });
    } catch (err) {
      // Never rethrow raw fetch errors (they can embed request config/headers).
      throw new Error(`request failed: ${redact(err?.message, secrets)}`);
    }

    if (!response.ok) {
      // Status/statusText only — never the URL, headers, or body.
      throw new Error(`HTTP ${response.status} ${redact(response.statusText ?? '', secrets)}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('response body was not valid JSON');
    }
    return extractText(payload);
  }

  /**
   * Classifier contract: NEVER throws on a bad model call. Transport/HTTP
   * failures become parserStatus 'model_error'; usable text flows through the
   * existing parser unchanged (so its statuses are stored as data).
   */
  async function classifyEvent(event) {
    let rawText;
    try {
      rawText = await requestCompletion(event);
    } catch (err) {
      return modelError(`model request failed: ${redact(err?.message, secrets)}`);
    }
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      return modelError('model returned no text content');
    }
    return parseModelResponse(rawText, { promptVersion, modelName });
  }

  return { name: 'model', promptVersion, modelName, classifyEvent };
}
