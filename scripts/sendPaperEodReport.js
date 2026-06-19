// scripts/sendPaperEodReport.js — MANUAL end-of-day PAPER report.
//
//   Preview locally (default; sends nothing, needs no webhook):
//     node --env-file=.env scripts/sendPaperEodReport.js --dry-run
//
//   Send to Discord (requires DISCORD_WEBHOOK_URL in .env):
//     node --env-file=.env scripts/sendPaperEodReport.js --send-discord
//
// Builds a sanitized end-of-day narrative from the LOCAL paper_trades /
// rejected_trades tables for one trading day and either prints it (dry run) or
// posts it to the configured Discord webhook. There is no learning-log table
// yet, so the narrative is derived from the order/rejection records; when there
// are none it prints a safe placeholder that still proves Discord delivery.
//
// - MANUAL ONLY: never part of npm test, startup, schedulers, or CI.
// - READ-ONLY over the database (SELECTs only; migrations are idempotent).
// - DRY RUN BY DEFAULT. It posts to Discord ONLY with --send-discord (or
//   --test-message), and only when DISCORD_WEBHOOK_URL is configured.
// - SANITIZED: counts, tickers, sides, statuses, our own rejection-reason
//   strings, and rounded P&L only. NEVER raw model responses, raw news
//   payloads, headlines, API keys, headers, request configs, or the webhook URL.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createDiscordWebhookClient } from '../src/notifications/discordWebhookClient.js';

/** Short message used by --test-message (proves delivery without a full report). */
export const EOD_TEST_MESSAGE =
  'ExaltedFable end-of-day report test — paper trading reports enabled.';

/** Cap on the per-list samples rendered in the report. */
const LIST_CAP = 10;

/**
 * Parse CLI args. Exported for tests. Dry run is the default; an actual send
 * happens only when --send-discord (or --test-message) is explicitly present.
 *   --day YYYY-MM-DD   --dry-run   --send-discord   --test-message
 */
export function parseArgs(argv) {
  const args = { day: null, send: false, testMessage: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--day' && argv[i + 1]) {
      const v = argv[i + 1].trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) args.day = v;
      i += 1;
    } else if (flag === '--send-discord') {
      args.send = true;
    } else if (flag === '--test-message') {
      args.testMessage = true;
    } else if (flag === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Collect sanitized EOD figures from paper_trades / rejected_trades. When `day`
 * is null, all rows are counted (useful for tests/ad-hoc); otherwise rows are
 * filtered to that UTC calendar day by created_at prefix. Reads ONLY whitelisted
 * columns — never headlines, raw_payload, or model responses (those live on
 * other tables and are not joined here).
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string|null} [opts.day]  'YYYY-MM-DD' or null for all-time
 */
export function collectEodData(db, { day = null } = {}) {
  const dayClause = day ? 'WHERE substr(created_at, 1, 10) = ?' : '';
  const dayParams = day ? [day] : [];

  const trades = db
    .prepare(
      `SELECT ticker, side, quantity, fill_price, pnl_usd, status, created_at
         FROM paper_trades ${dayClause}
        ORDER BY id DESC`
    )
    .all(...dayParams);

  const rejections = db
    .prepare(
      `SELECT ticker, side, quantity, reason, created_at
         FROM rejected_trades ${dayClause}
        ORDER BY id DESC`
    )
    .all(...dayParams);

  const longCount = trades.filter((t) => t.side === 'buy').length;
  const shortCount = trades.filter((t) => t.side === 'sell').length;
  const fills = trades.filter((t) => t.fill_price !== null && t.fill_price !== undefined).length;
  const realizedPnl = trades.reduce((sum, t) => sum + (Number(t.pnl_usd) || 0), 0);

  // Recurring rejection reasons, most common first.
  const reasonCounts = {};
  for (const r of rejections) reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  const rejectionReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => ({ reason, n }));

  // Best/worst ticker by realized P&L (only meaningful once P&L exists).
  const byTicker = {};
  for (const t of trades) byTicker[t.ticker] = (byTicker[t.ticker] ?? 0) + (Number(t.pnl_usd) || 0);
  const tickerPnl = Object.entries(byTicker).sort((a, b) => b[1] - a[1]);

  return {
    day,
    ordersSubmitted: trades.length,
    longCount,
    shortCount,
    fills,
    optionsCount: 0, // options not implemented in this slice
    realizedPnl: round2(realizedPnl),
    rejectedCount: rejections.length,
    proposals: trades.length + rejections.length, // proxy until a learning log exists
    rejectionReasons,
    bestTicker: tickerPnl.length > 0 ? tickerPnl[0][0] : null,
    worstTicker: tickerPnl.length > 0 ? tickerPnl[tickerPnl.length - 1][0] : null,
    trades: trades.slice(0, LIST_CAP).map((t) => ({
      ticker: t.ticker,
      side: t.side,
      qty: t.quantity,
      status: t.status,
      fillPrice: t.fill_price,
      pnl: t.pnl_usd,
    })),
  };
}

/**
 * Build the sanitized EOD report as printable lines. Includes the required
 * narrative sections (what / why / went well / went poorly / mistakes-lessons /
 * next-day ideas) derived ONLY from the counts above — no model calls, no free
 * text beyond our own rejection-reason strings.
 */
export function buildEodReport(data, { day = null } = {}) {
  const label = day ?? data.day ?? '(all-time)';
  const lines = [
    `ExaltedFable — End-of-Day PAPER report (${label})`,
    'PAPER trading only. Live trading disabled.',
    '',
  ];

  if (data.proposals === 0) {
    lines.push(
      'No paper-trading records for this day yet.',
      'This report still proves Discord delivery; once the paper loop runs and',
      'writes paper_trades / rejected_trades, the full narrative appears here.',
    );
    return lines;
  }

  lines.push(
    '— Figures —',
    `  proposals (orders + rejections): ${data.proposals}`,
    `  orders submitted:                ${data.ordersSubmitted}`,
    `  fills (known):                   ${data.fills}`,
    `  equity long / short:             ${data.longCount} / ${data.shortCount}`,
    `  options plans / orders:          ${data.optionsCount}`,
    `  rejected:                        ${data.rejectedCount}`,
    `  realized P&L (approx, USD):      ${data.realizedPnl}`,
    '',
    '— Rejections (most common) —',
  );
  if (data.rejectionReasons.length === 0) {
    lines.push('  (none)');
  } else {
    for (const r of data.rejectionReasons.slice(0, LIST_CAP)) lines.push(`  ${r.n}x  ${r.reason}`);
  }

  // Narrative — templated from the figures, deliberately conservative.
  const didNothingButRefuse = data.ordersSubmitted === 0;
  lines.push(
    '',
    '— What the bot did —',
    didNothingButRefuse
      ? `  Placed no paper orders; refused ${data.rejectedCount} proposal(s).`
      : `  Submitted ${data.ordersSubmitted} paper order(s) (${data.longCount} long, ` +
        `${data.shortCount} short) and refused ${data.rejectedCount}.`,
    '',
    '— Why it did it —',
    '  Acted only on real-model up-signals that cleared the conservative',
    '  confidence/impact/sentiment gates; everything else was refused by design.',
    '',
    '— What went well —',
    didNothingButRefuse
      ? '  The safety gates held — no marginal signal was traded.'
      : data.realizedPnl >= 0
        ? `  Net realized P&L is non-negative (${data.realizedPnl}); the gates let through up-signals.`
        : '  Orders reached the paper account and were logged with full provenance.',
    '',
    '— What went poorly —',
    didNothingButRefuse
      ? '  Nothing traded — sparse qualifying signals (expected outside active hours).'
      : data.realizedPnl < 0
        ? `  Net realized P&L is negative (${data.realizedPnl}); review the entries below.`
        : '  Nothing notable.',
    '',
    '— Mistakes / lessons —',
    data.rejectionReasons.length > 0
      ? `  Most common refusal: "${data.rejectionReasons[0].reason}" (x${data.rejectionReasons[0].n}) ` +
        '— check whether the gate matches the live signal distribution.'
      : '  No recurring refusal pattern to learn from yet.',
    '',
    '— Ideas for next trading day —',
    `  Re-run during market hours; ${data.bestTicker ? `watch ${data.bestTicker}; ` : ''}` +
      'consider tightening/loosening thresholds per the refusal pattern (manually).',
  );
  return lines;
}

/**
 * Core EOD logic, dependency-injected so tests run fully offline. Builds the
 * report and sends it ONLY when asked AND a Discord client is supplied. A
 * requested send with no client is a clear, safe failure (never a silent skip).
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string|null} [opts.day]
 * @param {boolean} [opts.send]         send the full report
 * @param {boolean} [opts.testMessage]  send EOD_TEST_MESSAGE instead of the report
 * @param {object|null} [opts.discordClient]  required when send/testMessage
 */
export async function runEodReport(
  db,
  { day = null, send = false, testMessage = false, discordClient = null } = {}
) {
  const data = collectEodData(db, { day });
  const lines = buildEodReport(data, { day });
  const content = lines.join('\n');
  const result = { day, data, lines, content, sent: false };

  if (send || testMessage) {
    if (!discordClient) {
      throw new Error(
        'sendPaperEodReport: Discord not configured — set DISCORD_WEBHOOK_URL to send, ' +
          'or use --dry-run to preview locally.'
      );
    }
    await discordClient.send({ content: testMessage ? EOD_TEST_MESSAGE : content });
    result.sent = true;
  }
  return result;
}

async function main() {
  const { day, send, testMessage } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const wantSend = send || testMessage;

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db); // idempotent; ensures paper_trades / rejected_trades exist

    // Build the Discord client only for an explicit send, and only with a
    // configured webhook. Missing webhook fails clearly (never a silent skip).
    let discordClient = null;
    if (wantSend) {
      if (!config.discord.webhookUrl) {
        console.error(
          'EOD report NOT SENT: Discord is not configured.\n' +
            'Set DISCORD_WEBHOOK_URL in your local .env (see .env.example), or run\n' +
            'with --dry-run to preview the report locally.'
        );
        process.exitCode = 1;
        return;
      }
      discordClient = createDiscordWebhookClient(config);
    }

    const result = await runEodReport(db, { day, send, testMessage, discordClient });
    for (const line of result.lines) console.log(line);
    if (result.sent) {
      console.log(testMessage ? 'Discord test message SENT.' : 'EOD report SENT to Discord.');
    } else {
      console.log('EOD report DRY RUN (nothing sent; pass --send-discord to deliver).');
    }
  } catch (err) {
    // Client errors are sanitized at their origin; print the message only.
    console.error(`EOD report FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
