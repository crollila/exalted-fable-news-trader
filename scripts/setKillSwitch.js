// scripts/setKillSwitch.js — MANUAL kill-switch control (PAPER risk halt).
//
//   Show today's state:       node scripts/setKillSwitch.js --status
//   Halt trading today:       node scripts/setKillSwitch.js --on --reason "manual halt"
//   Re-enable trading today:  node scripts/setKillSwitch.js --off
//   Another day:              add --day YYYY-MM-DD
//
// The switch is per trading day: the paper scripts refuse every new proposal
// while it is active, and a new day starts clean. The daily-loss monitor
// (MAX_DAILY_LOSS_USD) trips it automatically; this script is the manual
// override in both directions.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  clearKillSwitch,
  getRiskState,
  tradingDay,
  tripKillSwitch,
} from '../src/paper/riskState.js';

export function parseArgs(argv) {
  const args = { day: tradingDay(), on: false, off: false, status: false, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--day' && argv[i + 1] && /^\d{4}-\d{2}-\d{2}$/.test(argv[i + 1].trim())) {
      args.day = argv[i + 1].trim(); i += 1;
    } else if (flag === '--on') args.on = true;
    else if (flag === '--off') args.off = true;
    else if (flag === '--status') args.status = true;
    else if (flag === '--reason' && argv[i + 1]) { args.reason = argv[i + 1]; i += 1; }
  }
  return args;
}

function describe(state, day) {
  if (!state) return `risk_state ${day}: no row yet (kill switch inactive)`;
  return `risk_state ${day}: kill_switch=${state.kill_switch_active === 1 ? 'ACTIVE' : 'inactive'} ` +
    `realizedPnl=$${Number(state.realized_pnl_usd ?? 0).toFixed(2)} ` +
    `reason=${state.kill_switch_reason ?? '(none)'} updated=${state.updated_at}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.on && args.off) {
    console.error('setKillSwitch: pass --on OR --off, not both.');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db);
    if (args.on) {
      const state = tripKillSwitch(db, { day: args.day, reason: args.reason ?? 'manual halt via setKillSwitch.js' });
      console.log(`Kill switch SET for ${args.day}.`);
      console.log(describe(state, args.day));
    } else if (args.off) {
      const state = clearKillSwitch(db, { day: args.day, reason: args.reason ?? 'manually cleared via setKillSwitch.js' });
      console.log(`Kill switch CLEARED for ${args.day}.`);
      console.log(describe(state, args.day));
    } else {
      console.log(describe(getRiskState(db, args.day), args.day));
    }
  } catch (err) {
    console.error(`setKillSwitch FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
