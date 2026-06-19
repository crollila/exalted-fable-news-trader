// scripts/runPaperTradingLoop.js — MANUAL market-hours PAPER loop (Phase 5).
//
//   Dry run (default; NO orders):
//     node --env-file=.env scripts/runPaperTradingLoop.js --symbols AAPL,MSFT \
//       --classifier real_model --interval-minutes 15 --max-iterations 20
//
//   Execute PAPER orders during market hours (requires paper creds):
//     node --env-file=.env scripts/runPaperTradingLoop.js --symbols AAPL --execute-paper \
//       --interval-minutes 15 --max-iterations 20 --send-discord-eod-report
//
// PAPER-only. It REUSES the one-shot logic (executeOneShot) each iteration —
// no trade logic is duplicated here. It runs only during the US regular session
// by default (Mon-Fri 09:30-16:00 ET; weekends skipped), enforces a >= 5-minute
// interval and a max-iteration cap, prints a sanitized heartbeat per iteration,
// and exits cleanly on Ctrl+C. Live trading is impossible/disabled throughout.
//
// HOLIDAY LIMITATION: market-hours gating does NOT model US market holidays or
// half-days (no exchange calendar yet) — this is printed at startup.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createAlpacaPaperClient } from '../src/paper/alpacaPaperClient.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';
import { createDiscordWebhookClient } from '../src/notifications/discordWebhookClient.js';
import { isMarketOpen, marketStatusLabel, HOLIDAY_LIMITATION_NOTE } from '../src/paper/marketHours.js';
import {
  runPaperLoop,
  clampIntervalMinutes,
  clampMaxIterations,
  MIN_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MAX_ITERATIONS,
} from '../src/paper/paperTradingLoop.js';
import { parseArgs as parseOnceArgs, executeOneShot, oneLineSummary } from './runPaperTradingOnce.js';
import { runEodReport } from './sendPaperEodReport.js';

export { MIN_INTERVAL_MINUTES };

/**
 * Parse loop CLI args. The trade flags are parsed by the one-shot parser (so the
 * loop and one-shot stay in lockstep); the loop adds its own scheduling flags.
 */
export function parseArgs(argv) {
  const base = parseOnceArgs(argv);
  const loop = {
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    runOutsideMarketHours: false,
    sendDiscordEod: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--interval-minutes' && next) { loop.intervalMinutes = clampIntervalMinutes(next); i += 1; }
    else if (flag === '--max-iterations' && next) { loop.maxIterations = clampMaxIterations(next); i += 1; }
    else if (flag === '--run-outside-market-hours' && next) {
      loop.runOutsideMarketHours = String(next).trim().toLowerCase() === 'true'; i += 1;
    } else if (flag === '--send-discord-eod-report') { loop.sendDiscordEod = true; }
  }
  return { ...base, ...loop };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const hasCreds = Boolean(config.alpacaPaper.keyId && config.alpacaPaper.secretKey);

  if (args.executePaper && !hasCreds) {
    console.error(
      'Loop NOT STARTED in execute mode: Alpaca PAPER credentials are not configured.\n' +
        'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in .env, or omit --execute-paper.'
    );
    process.exitCode = 1;
    return;
  }

  console.log('Paper trading loop (manual, PAPER-only — live trading disabled)');
  console.log(`  ${HOLIDAY_LIMITATION_NOTE}`);
  console.log(
    `  symbols=${args.symbols.join(',')} mode=${args.executePaper ? 'EXECUTE-PAPER' : 'DRY-RUN'} ` +
      `interval=${args.intervalMinutes}m max-iter=${args.maxIterations} ` +
      `shorts=${args.allowShorts ? 'on' : 'off'} options=${args.allowOptions ? args.optionsMode : 'off'} ` +
      `outside-hours=${args.runOutsideMarketHours ? 'yes' : 'no'}`
  );

  // Graceful shutdown: SIGINT/SIGTERM flips a flag the loop checks each turn.
  let stopRequested = false;
  const onSignal = () => {
    if (!stopRequested) console.log('\nShutdown requested — finishing current iteration, then exiting…');
    stopRequested = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db);

    const paperClient = hasCreds ? createAlpacaPaperClient(config) : null;
    const priceSource = hasCreds ? createAlpacaTradesPriceSource(config) : null;

    const runOnce = async ({ nowMs }) => {
      const { result, lines } = await executeOneShot(db, { args, paperClient, priceSource, nowMs });
      for (const line of lines) console.log(line);
      return result ? oneLineSummary(result) : 'no eligible scored event';
    };

    const { iterations, stopped } = await runPaperLoop({
      maxIterations: args.maxIterations,
      intervalMs: args.intervalMinutes * 60_000,
      runOutsideMarketHours: args.runOutsideMarketHours,
      executePaper: args.executePaper,
      symbols: args.symbols,
      runOnce,
      isMarketOpen,
      marketStatusLabel,
      onHeartbeat: (line) => console.log(line),
      shouldStop: () => stopRequested,
    });

    console.log(`Loop finished after ${iterations} iteration(s)${stopped ? ' (stopped early)' : ''}.`);

    if (args.sendDiscordEod) {
      if (!config.discord.webhookUrl) {
        console.error('EOD report NOT SENT: DISCORD_WEBHOOK_URL is not configured (omit --send-discord-eod-report or set it).');
        process.exitCode = 1;
      } else {
        const discordClient = createDiscordWebhookClient(config);
        const eod = await runEodReport(db, { send: true, discordClient });
        for (const line of eod.lines) console.log(line);
        console.log('EOD report SENT to Discord.');
      }
    }
  } catch (err) {
    console.error(`Paper trading loop FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
