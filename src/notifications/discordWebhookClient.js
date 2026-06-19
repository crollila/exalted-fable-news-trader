// src/notifications/discordWebhookClient.js — Minimal Discord webhook client
// for end-of-day PAPER reports.
//
// Safety regime mirrors the Alpaca clients:
// - Explicit construction only; throws "not configured" without a webhook URL.
//   Nothing runs at import time, on startup, in schedulers, or in npm test.
// - The webhook URL (and its token) come ONLY from config (src/config.js reads
//   process.env; nothing here touches process.env). The URL is the POST target
//   and goes NOWHERE else — never thrown, logged, returned, or persisted.
// - Errors are sanitized: static text + status codes, with the URL and its
//   token defensively redacted so neither can ever leak.
// - The HTTP function is injectable; tests inject fakes and never hit the network.
//
// This is a notifications-only sender. It carries no trading logic and no
// market data; it only posts sanitized report text the caller already built.

/** Discord rejects messages longer than 2000 characters; truncate to fit. */
export const MAX_CONTENT_CHARS = 2000;

/** Replace any occurrence of the given secrets in text with [redacted]. */
function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Create a Discord webhook client.
 *
 * Explicit construction only — the single place a Discord send path can come
 * into existence, and only with a configured webhook URL.
 *
 * @param {object} config  result of loadConfig(); uses config.discord.webhookUrl
 * @param {object} [options]
 * @param {Function} [options.httpFetch]  injected fetch-compatible function
 *   (tests inject fakes; real use defaults to globalThis.fetch)
 * @returns {{ name: string, send: (m: {content: string}) => Promise<{ok: boolean, status: number}> }}
 * @throws immediately (before any HTTP) if the webhook URL is not configured.
 */
export function createDiscordWebhookClient(config, { httpFetch } = {}) {
  const url = config?.discord?.webhookUrl;
  if (!url) {
    throw new Error(
      'discordWebhookClient: not configured — set DISCORD_WEBHOOK_URL in .env ' +
        '(see .env.example). No HTTP call was made.'
    );
  }
  // Redact both the full URL and its trailing token segment from any error text.
  const token = String(url).split('/').filter(Boolean).pop();
  const secrets = [url, token].filter(Boolean);
  const doFetch = httpFetch ?? globalThis.fetch;

  /**
   * Send one message. Returns a sanitized { ok, status } (Discord replies 204
   * No Content on success). Throws sanitized errors only — the URL/token can
   * never appear in a thrown message.
   */
  async function send({ content } = {}) {
    const text = String(content ?? '').trim();
    if (!text) {
      throw new Error('discordWebhookClient: content must be a non-empty string');
    }
    const body = JSON.stringify({ content: text.slice(0, MAX_CONTENT_CHARS) });

    let response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      // Never rethrow the raw fetch error (it can embed the request URL).
      throw new Error(`discordWebhookClient: request failed: ${redact(err?.message, secrets)}`);
    }

    if (!response.ok) {
      // Status/statusText only — never the URL, headers, or body.
      throw new Error(
        `discordWebhookClient: HTTP ${response.status} ${redact(response.statusText ?? '', secrets)}`
      );
    }
    return { ok: true, status: response.status };
  }

  return { name: 'discord', send };
}

/**
 * Sanitized, non-secret view of the configured Discord target for display.
 * NEVER includes the webhook URL — only whether one is configured, plus the
 * server/channel IDs (metadata, not secrets).
 */
export function describeDiscordTarget(config) {
  return {
    webhookConfigured: Boolean(config?.discord?.webhookUrl),
    serverId: config?.discord?.serverId ?? null,
    channelId: config?.discord?.channelId ?? null,
  };
}
