// scripts/smokeAlpacaNews.js — MANUAL live smoke check for the Alpaca News
// HTTP transport. Diagnostic tool only.
//
//   Run:  node --env-file=.env scripts/smokeAlpacaNews.js [--symbols AAPL,MSFT] [--limit 5]
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   This is the project's only live-network touchpoint, run by a human.
// - Reads credentials ONLY via loadConfig() (src/config.js); this file never
//   touches process.env for secrets. Use --env-file=.env (built into Node)
//   to load your local .env — no dotenv dependency, no .env parsing here.
// - SANITIZED OUTPUT ONLY: prints count, provider, headline, ticker/symbols,
//   published timestamp, provider event id, and the public article URL.
//   Never prints keys, auth headers, request URLs, or raw payloads (the
//   normalized event's `raw` field is never rendered).
// - One-shot tiny fetch (limit capped at 10). No polling, no scheduling,
//   no database writes, no trading, no model calls.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createAlpacaNewsHttpTransport } from '../src/providers/alpacaNewsHttpTransport.js';
import { createAlpacaNewsProvider } from '../src/providers/alpacaNewsProvider.js';

export const MAX_SMOKE_LIMIT = 10;

/** Truncate display text; never used on secrets (none reach this module). */
export function truncate(text, max = 100) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Format ONE normalized event using a strict whitelist of safe fields.
 * Anything not listed here (including event.raw) is never rendered.
 */
export function formatEventLine(event) {
  const symbols = Array.isArray(event.symbols) ? event.symbols.join(',') : '';
  const idPart = event.providerEventId ? ` (id: ${truncate(event.providerEventId, 40)})` : '';
  // Alpaca article URLs are public links; include only when clearly http(s).
  const urlPart =
    typeof event.url === 'string' && /^https?:\/\//.test(event.url)
      ? `\n      ${truncate(event.url, 120)}`
      : '';
  return `  - [${event.publishedAt}] ${event.ticker ?? '?'} (${symbols}) ${truncate(event.headline, 90)}${idPart}${urlPart}`;
}

/** Build the full sanitized report as an array of printable lines. */
export function buildSmokeReport(events, { provider = 'alpaca' } = {}) {
  const lines = [`Alpaca News smoke check: fetched ${events.length} event(s) via provider "${provider}"`];
  for (const event of events) lines.push(formatEventLine(event));
  if (events.length === 0) {
    lines.push('  (zero events returned — try different symbols or a wider window)');
  }
  return lines;
}

/** Parse minimal CLI args: --symbols A,B --limit N. Exported for tests. */
export function parseArgs(argv) {
  const args = { symbols: ['AAPL'], limit: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--symbols' && argv[i + 1]) {
      args.symbols = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (argv[i] === '--limit' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) args.limit = Math.min(n, MAX_SMOKE_LIMIT);
      i += 1;
    }
  }
  args.limit = Math.min(args.limit, MAX_SMOKE_LIMIT); // tiny sample, always
  return args;
}

async function main() {
  const { symbols, limit } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (!config.alpacaNews.keyId || !config.alpacaNews.secretKey) {
    console.error(
      'Smoke check NOT RUN: Alpaca News is not configured.\n' +
        'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your local .env\n' +
        '(see .env.example) and run with:  node --env-file=.env scripts/smokeAlpacaNews.js'
    );
    process.exit(1);
  }

  try {
    // Explicit construction — the only place a real transport is enabled.
    const transport = createAlpacaNewsHttpTransport(config);
    const provider = createAlpacaNewsProvider({ fetchRawNews: transport });
    const events = await provider.fetchNews({ symbols, limit });
    for (const line of buildSmokeReport(events, { provider: provider.name })) {
      console.log(line);
    }
    console.log('Smoke check PASSED (transport reachable, payload normalized).');
  } catch (err) {
    // Transport errors are already sanitized/redacted at the source.
    console.error(`Smoke check FAILED: ${err.message}`);
    process.exit(1);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
