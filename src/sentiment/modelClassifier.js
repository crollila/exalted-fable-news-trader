// src/sentiment/modelClassifier.js - OpenAI production classifier.
//
// The production classifier uses the OpenAI Responses API behind the existing
// Classifier contract. It is explicit construction only, uses config-only
// credentials, sends secrets in headers only, and never throws from
// classifyEvent. Bad HTTP/model/parser outcomes are stored as data through the
// existing parseModelResponse/insertSentimentScore path.

import { NEWS_TYPES, DIRECTIONS, TIME_HORIZONS } from './classifierContract.js';
import { parseModelResponse } from './parseModelResponse.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1/responses';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export const MODEL_PROMPT_VERSION = 'model_v1';
export const DEFAULT_MAX_TOKENS = 1024;

const MAX_BODY_CHARS = 2000;

export const CLASSIFICATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    news_type: { type: 'string', enum: NEWS_TYPES },
    sentiment_score: { type: 'number', minimum: -1, maximum: 1 },
    impact_score: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    direction: { type: 'string', enum: DIRECTIONS },
    time_horizon: { anyOf: [{ type: 'string', enum: TIME_HORIZONS }, { type: 'null' }] },
    affected_symbols: { type: 'array', items: { type: 'string' } },
    rationale: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'news_type',
    'sentiment_score',
    'impact_score',
    'confidence',
    'direction',
    'time_horizon',
    'affected_symbols',
    'rationale',
  ],
});

function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function buildSystemPrompt() {
  return [
    'You are a financial news classifier for an event-study research system.',
    'Classify the news item and estimate its likely short-term market impact.',
    'Respond with only the requested JSON object. Do not include prose,',
    'markdown, code fences, request metadata, or chain-of-thought.',
    '',
    `news_type must be one of ${JSON.stringify(NEWS_TYPES)}.`,
    'sentiment_score must be -1.0 to 1.0.',
    'impact_score and confidence must be 0.0 to 1.0.',
    `direction must be one of ${JSON.stringify(DIRECTIONS)}.`,
    `time_horizon must be one of ${JSON.stringify(TIME_HORIZONS)} or null.`,
    'affected_symbols must be uppercase ticker strings.',
    'Use "unclear" and low scores when the item is not market-relevant.',
  ].join('\n');
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}...`;
}

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

function usageFrom(payload) {
  const u = payload?.usage;
  if (!u || typeof u !== 'object') return null;
  return {
    inputTokens: Number.isFinite(Number(u.input_tokens)) ? Number(u.input_tokens) : null,
    outputTokens: Number.isFinite(Number(u.output_tokens)) ? Number(u.output_tokens) : null,
    totalTokens: Number.isFinite(Number(u.total_tokens)) ? Number(u.total_tokens) : null,
  };
}

function extractOpenAiText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const parts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const c of Array.isArray(item?.content) ? item.content : []) {
      if (typeof c?.text === 'string') parts.push(c.text);
      else if (typeof c?.json === 'object') parts.push(JSON.stringify(c.json));
    }
  }
  return parts.join('');
}

function extractAnthropicText(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function modelError({ promptVersion, modelName, message, provider, usage = null }) {
  return {
    promptVersion,
    modelName,
    parserStatus: 'model_error',
    output: null,
    rawModelResponse: '',
    errors: [message],
    provider,
    usage,
  };
}

export function createModelClassifier(
  config,
  {
    httpFetch,
    baseUrl = OPENAI_BASE_URL,
    model,
    promptVersion = MODEL_PROMPT_VERSION,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = {}
) {
  const apiKey = config?.model?.openaiApiKey;
  if (!apiKey) {
    throw new Error(
      'modelClassifier(openai): not configured - set OPENAI_API_KEY in .env ' +
        '(see .env.example). No model call was made.'
    );
  }
  const modelName = model || config?.model?.openaiModel;
  if (!modelName) {
    throw new Error(
      'modelClassifier(openai): not configured - set OPENAI_MODEL in .env ' +
        '(see .env.example). No model call was made.'
    );
  }

  const secrets = [apiKey];
  const doFetch = httpFetch ?? globalThis.fetch;
  const systemPrompt = buildSystemPrompt();

  async function requestCompletion(event) {
    const body = JSON.stringify({
      model: modelName,
      instructions: systemPrompt,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: buildUserPrompt(event) }],
        },
      ],
      max_output_tokens: maxTokens,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'exalted_fable_news_classification',
          strict: true,
          schema: CLASSIFICATION_SCHEMA,
        },
      },
    });

    let response;
    try {
      response = await doFetch(baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      throw new Error(`request failed: ${redact(err?.message, secrets)}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${redact(response.statusText ?? '', secrets)}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('response body was not valid JSON');
    }
    return { text: extractOpenAiText(payload), usage: usageFrom(payload) };
  }

  async function classifyEvent(event) {
    let result;
    try {
      result = await requestCompletion(event);
    } catch (err) {
      return modelError({
        promptVersion,
        modelName,
        provider: 'openai',
        message: `model request failed: ${redact(err?.message, secrets)}`,
      });
    }
    if (typeof result.text !== 'string' || result.text.trim() === '') {
      return modelError({
        promptVersion,
        modelName,
        provider: 'openai',
        message: 'model returned no text content',
        usage: result.usage,
      });
    }
    const parsed = parseModelResponse(result.text, { promptVersion, modelName });
    parsed.provider = 'openai';
    parsed.usage = result.usage;
    return parsed;
  }

  return { name: 'openai', provider: 'openai', promptVersion, modelName, classifyEvent };
}

export function createAnthropicModelClassifier(
  config,
  {
    httpFetch,
    baseUrl = ANTHROPIC_BASE_URL,
    model,
    promptVersion = MODEL_PROMPT_VERSION,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = {}
) {
  const apiKey = config?.model?.anthropicApiKey;
  if (!apiKey) {
    throw new Error(
      'modelClassifier(anthropic): not configured - set ANTHROPIC_API_KEY in .env ' +
        '(see .env.example). No model call was made.'
    );
  }
  const modelName = model || config?.model?.anthropicModel || config?.model?.classifierModel;
  if (!modelName) {
    throw new Error(
      'modelClassifier(anthropic): not configured - set ANTHROPIC_MODEL in .env ' +
        '(see .env.example). No model call was made.'
    );
  }
  const secrets = [apiKey];
  const doFetch = httpFetch ?? globalThis.fetch;
  const systemPrompt = buildSystemPrompt();

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
      throw new Error(`request failed: ${redact(err?.message, secrets)}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${redact(response.statusText ?? '', secrets)}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('response body was not valid JSON');
    }
    return { text: extractAnthropicText(payload), usage: usageFrom(payload) };
  }

  async function classifyEvent(event) {
    let result;
    try {
      result = await requestCompletion(event);
    } catch (err) {
      return modelError({
        promptVersion,
        modelName,
        provider: 'anthropic',
        message: `model request failed: ${redact(err?.message, secrets)}`,
      });
    }
    if (typeof result.text !== 'string' || result.text.trim() === '') {
      return modelError({
        promptVersion,
        modelName,
        provider: 'anthropic',
        message: 'model returned no text content',
        usage: result.usage,
      });
    }
    const parsed = parseModelResponse(result.text, { promptVersion, modelName });
    parsed.provider = 'anthropic';
    parsed.usage = result.usage;
    return parsed;
  }

  return { name: 'anthropic', provider: 'anthropic', promptVersion, modelName, classifyEvent };
}
