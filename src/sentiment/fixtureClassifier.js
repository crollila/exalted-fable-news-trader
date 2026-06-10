// src/sentiment/fixtureClassifier.js — Deterministic classifier (NO model).
//
// Mirrors the providers' injected-transport pattern: the "model" is an
// injected responder function returning raw response text. No responder is
// configured by default, so this classifier is structurally incapable of
// calling any model API or needing keys. Real model clients are a later,
// separately approved phase.

import { parseModelResponse } from './parseModelResponse.js';

function noResponderConfigured() {
  throw new Error(
    'fixtureClassifier: no responder configured. Inject respond(event) -> rawText ' +
      '(e.g. canned fixture responses in tests). Real model clients are a later phase.'
  );
}

/**
 * Create a fixture-backed classifier.
 * @param {object} options
 * @param {string} [options.promptVersion='sentiment_v1']
 * @param {string} [options.modelName='fixture']
 * @param {(event: object) => string} [options.respond]
 *   injected deterministic responder returning raw model-response text.
 * @returns {import('./classifierContract.js').Classifier}
 */
export function createFixtureClassifier({
  promptVersion = 'sentiment_v1',
  modelName = 'fixture',
  respond = noResponderConfigured,
} = {}) {
  /**
   * Never throws on bad model output: responder failures become
   * parserStatus 'model_error', parse failures become their respective
   * statuses. Classification can never block ingestion.
   */
  async function classifyEvent(event) {
    let rawText;
    try {
      rawText = respond(event);
    } catch (err) {
      return {
        promptVersion,
        modelName,
        parserStatus: 'model_error',
        output: null,
        rawModelResponse: '',
        errors: [`responder failed: ${err.message}`],
      };
    }
    return parseModelResponse(rawText, { promptVersion, modelName });
  }

  return { name: 'fixture', promptVersion, modelName, classifyEvent };
}
