// tests/discordWebhookClient.test.js — Network-free tests for the Discord
// webhook client. Importing the module runs NOTHING; every HTTP call goes
// through an injected fake fetch. The load-bearing assertions: the webhook URL
// and its token are redacted from all errors and never appear in any output.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiscordWebhookClient,
  describeDiscordTarget,
  MAX_CONTENT_CHARS,
} from '../src/notifications/discordWebhookClient.js';

const TOKEN = 'SUPER-SECRET-TOKEN-MUST-NOT-LEAK';
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;

function discordConfig(extra = {}) {
  return { discord: { webhookUrl: WEBHOOK, serverId: '111', channelId: '222', ...extra } };
}

function fakeFetch(responder) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchFn, calls };
}

// --- configuration ---------------------------------------------------------

test('createDiscordWebhookClient throws clearly when the webhook is missing', () => {
  assert.throws(() => createDiscordWebhookClient({ discord: { webhookUrl: null } }), /not configured/);
  assert.throws(() => createDiscordWebhookClient({}), /not configured/);
});

test('describeDiscordTarget reports metadata only and never the webhook URL', () => {
  const t = describeDiscordTarget(discordConfig());
  assert.deepEqual(t, { webhookConfigured: true, serverId: '111', channelId: '222' });
  assert.ok(!JSON.stringify(t).includes(TOKEN));
  assert.equal(describeDiscordTarget({}).webhookConfigured, false);
});

// --- send success ----------------------------------------------------------

test('send posts { content } to the webhook and returns a sanitized status', async () => {
  const { fetchFn, calls } = fakeFetch(() => ({ ok: true, status: 204, statusText: 'No Content' }));
  const client = createDiscordWebhookClient(discordConfig(), { httpFetch: fetchFn });
  const res = await client.send({ content: 'hello paper world' });
  assert.deepEqual(res, { ok: true, status: 204 });
  assert.equal(calls[0].url, WEBHOOK);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: 'hello paper world' });
});

test('send requires non-empty content and truncates to the Discord limit', async () => {
  const { fetchFn, calls } = fakeFetch(() => ({ ok: true, status: 204 }));
  const client = createDiscordWebhookClient(discordConfig(), { httpFetch: fetchFn });
  await assert.rejects(() => client.send({ content: '   ' }), /non-empty string/);
  await client.send({ content: 'x'.repeat(5000) });
  assert.equal(JSON.parse(calls[0].init.body).content.length, MAX_CONTENT_CHARS);
});

// --- error sanitization ----------------------------------------------------

test('an HTTP error is redacted and reports status only (no URL/token)', async () => {
  const { fetchFn } = fakeFetch(() => ({
    ok: false,
    status: 401,
    statusText: `unauthorized for ${WEBHOOK}`, // pretend the URL leaked into statusText
  }));
  const client = createDiscordWebhookClient(discordConfig(), { httpFetch: fetchFn });
  await assert.rejects(
    () => client.send({ content: 'hi' }),
    (err) => {
      assert.match(err.message, /HTTP 401/);
      assert.ok(!err.message.includes(WEBHOOK));
      assert.ok(!err.message.includes(TOKEN));
      assert.match(err.message, /\[redacted\]/);
      return true;
    }
  );
});

test('a network failure is sanitized and never rethrows the raw error/URL', async () => {
  const { fetchFn } = fakeFetch(() => {
    throw new Error(`connect ECONNREFUSED to ${WEBHOOK}`);
  });
  const client = createDiscordWebhookClient(discordConfig(), { httpFetch: fetchFn });
  await assert.rejects(
    () => client.send({ content: 'hi' }),
    (err) => {
      assert.match(err.message, /request failed/);
      assert.ok(!err.message.includes(WEBHOOK));
      assert.ok(!err.message.includes(TOKEN));
      return true;
    }
  );
});

test('importing the client module performs no network and requires no credentials', () => {
  assert.equal(typeof createDiscordWebhookClient, 'function');
  assert.equal(typeof MAX_CONTENT_CHARS, 'number');
});
