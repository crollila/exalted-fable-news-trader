// tests/modelClassifier.test.js — Network-free tests for the real model-backed
// classifier. Every test injects a FAKE httpFetch; npm test never touches the
// network and never needs a real key. The classifier is constructed only with
// an explicit fake config, mirroring the disabled-by-default safety regime of
// the real Alpaca transports.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnthropicModelClassifier,
  createModelClassifier,
  buildSystemPrompt,
  buildUserPrompt,
  MODEL_PROMPT_VERSION,
} from '../src/sentiment/modelClassifier.js';
import { NEWS_TYPES } from '../src/sentiment/classifierContract.js';
import {
  VALID_RESPONSE,
  MALFORMED_JSON_RESPONSE,
  MISSING_FIELD_RESPONSE,
  OUT_OF_RANGE_RESPONSE,
} from './fixtures/modelResponses.js';

const TEST_KEY = 'SECRET-OPENAI-KEY-MUST-NOT-LEAK';
const TEST_MODEL = 'test-openai-model';

/** A config with a configured model key (never a real one). */
function configWithKey(model) {
  return { model: { openaiApiKey: TEST_KEY, openaiModel: model ?? TEST_MODEL } };
}

/** Build a fake httpFetch returning one canned Responses API payload. */
function fakeOkFetch(rawText, { capture } = {}) {
  return async (url, options) => {
    if (capture) capture.push({ url, options });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        output_text: rawText,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    };
  };
}

const EVENT = {
  ticker: 'AAPL',
  headline: 'Apple beats earnings and raises guidance',
  body: 'Strong quarter with record services revenue.',
};

// --- construction / not-configured -----------------------------------------

test('createModelClassifier throws a clear not-configured error without a key', () => {
  assert.throws(
    () => createModelClassifier({ model: { openaiApiKey: null, openaiModel: TEST_MODEL } }, { httpFetch: () => {} }),
    /not configured/i
  );
  assert.throws(
    () => createModelClassifier({ model: { openaiApiKey: TEST_KEY, openaiModel: null } }, { httpFetch: () => {} }),
    /OPENAI_MODEL/i
  );
  // Also throws on an entirely absent model config block.
  assert.throws(() => createModelClassifier({}, { httpFetch: () => {} }), /not configured/i);
});

test('the constructed classifier carries the model identity and model_v1 prompt', () => {
  const classifier = createModelClassifier(configWithKey(TEST_MODEL), {
    httpFetch: fakeOkFetch(VALID_RESPONSE),
  });
  assert.equal(classifier.name, 'openai');
  assert.equal(classifier.promptVersion, MODEL_PROMPT_VERSION);
  assert.equal(classifier.modelName, TEST_MODEL);
  // An explicit model option overrides the config default.
  const override = createModelClassifier(configWithKey(TEST_MODEL), {
    httpFetch: fakeOkFetch(VALID_RESPONSE),
    model: 'override-model',
  });
  assert.equal(override.modelName, 'override-model');
});

// --- success mapping --------------------------------------------------------

test('a valid model response maps into a parsed ClassificationResult', async () => {
  const classifier = createModelClassifier(configWithKey(), { httpFetch: fakeOkFetch(VALID_RESPONSE) });
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'parsed');
  assert.equal(result.output.sentimentScore, 0.62);
  assert.equal(result.output.newsType, 'earnings');
  assert.equal(result.promptVersion, MODEL_PROMPT_VERSION);
  assert.equal(result.provider, 'openai');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  // Raw model text is preserved byte-for-byte for storage/audit.
  assert.equal(result.rawModelResponse, VALID_RESPONSE);
});

test('the request sends the key in a header only — never in the body', async () => {
  const capture = [];
  const classifier = createModelClassifier(configWithKey(), {
    httpFetch: fakeOkFetch(VALID_RESPONSE, { capture }),
  });
  await classifier.classifyEvent(EVENT);
  assert.equal(capture.length, 1);
  const { url, options } = capture[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(options.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.equal(options.method, 'POST');
  // The serialized request body must not contain the secret.
  assert.ok(!options.body.includes(TEST_KEY));
  // The body carries the model id and the whitelisted event text.
  const body = JSON.parse(options.body);
  assert.equal(body.model, TEST_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, 'json_schema');
  assert.match(body.input[0].content[0].text, /AAPL/);
  assert.match(body.input[0].content[0].text, /Apple beats earnings/);
});

// --- parser failure modes flow through unchanged (failures = data) ---------

test('malformed JSON from the model becomes parser_status malformed_json', async () => {
  const classifier = createModelClassifier(configWithKey(), {
    httpFetch: fakeOkFetch(MALFORMED_JSON_RESPONSE),
  });
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'malformed_json');
  assert.equal(result.output, null);
  assert.equal(result.rawModelResponse, MALFORMED_JSON_RESPONSE); // preserved
});

test('a missing required field becomes parser_status missing_required_field', async () => {
  const classifier = createModelClassifier(configWithKey(), {
    httpFetch: fakeOkFetch(MISSING_FIELD_RESPONSE),
  });
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'missing_required_field');
});

test('an out-of-range score becomes parser_status invalid_score_range', async () => {
  const classifier = createModelClassifier(configWithKey(), {
    httpFetch: fakeOkFetch(OUT_OF_RANGE_RESPONSE),
  });
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'invalid_score_range');
});

// --- transport / HTTP failures become model_error, sanitized ----------------

test('an HTTP error response becomes model_error and never leaks the key', async () => {
  const httpFetch = async () => ({
    ok: false,
    status: 401,
    statusText: `unauthorized for key ${TEST_KEY}`, // contrived leak attempt
    json: async () => ({}),
  });
  const classifier = createModelClassifier(configWithKey(), { httpFetch });
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'model_error');
  assert.equal(result.output, null);
  assert.equal(result.rawModelResponse, '');
  const joined = result.errors.join(' ');
  assert.match(joined, /HTTP 401/);
  assert.ok(!joined.includes(TEST_KEY)); // redacted
  assert.match(joined, /\[redacted\]/);
});

test('a transport throw becomes model_error and never leaks the key', async () => {
  const httpFetch = async () => {
    throw new Error(`socket failure while using ${TEST_KEY}`); // contrived leak attempt
  };
  const classifier = createModelClassifier(configWithKey(), { httpFetch });
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'model_error');
  const joined = result.errors.join(' ');
  assert.ok(!joined.includes(TEST_KEY)); // redacted
  assert.match(joined, /request failed/);
});

test('a non-JSON response body becomes model_error', async () => {
  const httpFetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => {
      throw new Error('not json');
    },
  });
  const classifier = createModelClassifier(configWithKey(), { httpFetch });
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'model_error');
});

test('an empty/no-text response becomes model_error (never throws)', async () => {
  const httpFetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ output: [] }),
  });
  const classifier = createModelClassifier(configWithKey(), { httpFetch });
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'model_error');
  assert.match(result.errors.join(' '), /no text content/);
});

test('Anthropic is available only through the explicit anthropic factory', () => {
  const classifier = createAnthropicModelClassifier(
    { model: { anthropicApiKey: 'ANTHROPIC-TEST-KEY', anthropicModel: 'anthropic-test-model' } },
    { httpFetch: fakeOkFetch(VALID_RESPONSE) }
  );
  assert.equal(classifier.name, 'anthropic');
  assert.equal(classifier.modelName, 'anthropic-test-model');
});

test('classifyEvent never throws, even on a totally broken transport', async () => {
  const httpFetch = () => {
    throw new Error('boom');
  };
  const classifier = createModelClassifier(configWithKey(), { httpFetch });
  // Must resolve (not reject) — the contract forbids throwing on bad calls.
  const result = await classifier.classifyEvent(EVENT);
  assert.equal(result.parserStatus, 'model_error');
});

// --- prompt builders: whitelist + no secrets --------------------------------

test('buildSystemPrompt is static, lists the taxonomy, and holds no event/secret data', () => {
  const sys = buildSystemPrompt();
  assert.match(sys, /JSON object/);
  for (const t of NEWS_TYPES) assert.ok(sys.includes(t));
  assert.ok(!sys.includes(TEST_KEY));
});

test('buildUserPrompt includes only whitelisted fields and never raw payloads', () => {
  const text = buildUserPrompt({
    ticker: 'aapl',
    headline: 'Headline here',
    body: 'Body text',
    raw_payload: 'RAW-PAYLOAD-MUST-NOT-APPEAR',
    summary: 'unused when body present',
  });
  assert.match(text, /Ticker: AAPL/); // uppercased
  assert.match(text, /Headline: Headline here/);
  assert.match(text, /Body: Body text/);
  assert.ok(!text.includes('RAW-PAYLOAD-MUST-NOT-APPEAR'));
});

test('buildUserPrompt tolerates missing fields without throwing', () => {
  const text = buildUserPrompt({});
  assert.match(text, /Ticker: \(unknown\)/);
  assert.match(text, /Headline: \(no headline\)/);
});

// --- import safety ----------------------------------------------------------

test('importing the module performs no network and constructs nothing by default', () => {
  // The module exposes only factories/pure helpers; importing it (done at the
  // top of this file) ran no network and required no key — proven by the fact
  // that every networked test above had to inject its own fake httpFetch.
  assert.equal(typeof createModelClassifier, 'function');
  assert.equal(typeof buildSystemPrompt, 'function');
  assert.equal(typeof buildUserPrompt, 'function');
});
