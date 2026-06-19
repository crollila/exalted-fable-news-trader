// scripts/smokeDiscordWebhook.js — MANUAL Discord connection test.
//
//   Run:  node --env-file=.env scripts/smokeDiscordWebhook.js
//
// Sends ONE tiny test message to the configured Discord webhook so you can
// confirm end-of-day PAPER reports will land in the right channel.
//
// - MANUAL ONLY: never part of npm test, startup, schedulers, or CI. One
//   human-invoked send, then exit. No polling/scheduling/background jobs.
// - Credentials/webhook ONLY via config (src/config.js); this file never reads
//   process.env. Use --env-file=.env to load your local .env.
// - SANITIZED OUTPUT: prints the configured server id, channel id (metadata),
//   whether a webhook is configured, and the send result. It NEVER prints the
//   webhook URL, the token, headers, or any request config.
// - No trading, no model calls, no market-data calls.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import {
  createDiscordWebhookClient,
  describeDiscordTarget,
} from '../src/notifications/discordWebhookClient.js';

/** The exact message posted by the smoke check. */
export const TEST_MESSAGE =
  'ExaltedFable Discord connection test — paper trading reports enabled.';

/**
 * Build the sanitized smoke-check report lines. Whitelist only: server id,
 * channel id, whether a webhook is configured, and the send result string.
 * The webhook URL is NEVER passed in here and can never be rendered.
 */
export function buildSmokeLines({ webhookConfigured, serverId, channelId, sendResult } = {}) {
  return [
    'ExaltedFable Discord webhook smoke check',
    `  configured server id:  ${serverId ?? '(missing)'}`,
    `  configured channel id: ${channelId ?? '(missing)'}`,
    `  webhook configured:    ${webhookConfigured ? 'yes' : 'no'}`,
    `  send result:           ${sendResult ?? '(not attempted)'}`,
  ];
}

async function main() {
  const config = loadConfig();
  const target = describeDiscordTarget(config); // { webhookConfigured, serverId, channelId } — no URL

  if (!target.webhookConfigured) {
    for (const line of buildSmokeLines({ ...target, sendResult: 'SKIPPED (no webhook configured)' })) {
      console.log(line);
    }
    console.error(
      'Discord smoke check NOT SENT: set DISCORD_WEBHOOK_URL in your local .env ' +
        '(see .env.example).'
    );
    process.exitCode = 1;
    return;
  }

  let sendResult;
  try {
    const client = createDiscordWebhookClient(config);
    await client.send({ content: TEST_MESSAGE });
    sendResult = 'success';
  } catch (err) {
    // The client already sanitizes/redacts; print the message only.
    sendResult = `failure: ${err.message}`;
    process.exitCode = 1;
  }
  for (const line of buildSmokeLines({ ...target, sendResult })) console.log(line);
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
