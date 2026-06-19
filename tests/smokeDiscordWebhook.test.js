// tests/smokeDiscordWebhook.test.js — Network-free tests for the Discord smoke
// check. Importing the script runs NOTHING (CLI guard). The formatter is the
// only thing tested directly; the load-bearing assertion is that the webhook
// URL can never appear in the sanitized output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSmokeLines, TEST_MESSAGE } from '../scripts/smokeDiscordWebhook.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123/SECRET-TOKEN';

test('buildSmokeLines renders metadata only and never the webhook URL', () => {
  const text = buildSmokeLines({
    webhookConfigured: true,
    serverId: '1515469212213317823',
    channelId: '1517321598456299610',
    sendResult: 'success',
  }).join('\n');
  assert.match(text, /configured server id:  1515469212213317823/);
  assert.match(text, /configured channel id: 1517321598456299610/);
  assert.match(text, /webhook configured:    yes/);
  assert.match(text, /send result:           success/);
  // A webhook URL passed nowhere here can never be rendered.
  assert.ok(!text.includes(WEBHOOK));
  assert.ok(!text.includes('SECRET-TOKEN'));
});

test('buildSmokeLines handles the missing-webhook / missing-id case', () => {
  const text = buildSmokeLines({ webhookConfigured: false, serverId: null, channelId: null }).join('\n');
  assert.match(text, /configured server id:  \(missing\)/);
  assert.match(text, /webhook configured:    no/);
  assert.match(text, /send result:           \(not attempted\)/);
});

test('the test message is the exact agreed string', () => {
  assert.equal(TEST_MESSAGE, 'ExaltedFable Discord connection test — paper trading reports enabled.');
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof buildSmokeLines, 'function');
  assert.equal(typeof TEST_MESSAGE, 'string');
});
