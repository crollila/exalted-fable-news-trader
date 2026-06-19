// scripts/runPaperTradingOnce.js — MANUAL one-shot PAPER trade (Phase 5 slice).
//
//   Dry run (default; NO order, NO credentials needed beyond DATABASE_URL):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL
//
//   Execute a PAPER order (requires Alpaca paper creds in .env):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL --execute-paper
//
// WHAT IT DOES (smallest safe vertical slice):
//   1. select ONE recent, real-model-scored (prompt_version=model_v1) news event
//      whose ticker is in the CLI allow-list,
//   2. build a conservative equity-LONG market-BUY proposal,
//   3. run a minimal risk gate (assessProposal),
//   4. DRY RUN by default: print the proposal/decision and STOP — no order;
//      with --execute-paper, submit a PAPER market order via the paper client,
//   5. persist the outcome: paper_trades on a sent order, rejected_trades on a
//      risk refusal,
//   6. print a sanitized report.
//
// HARD SAFETY:
// - PAPER ONLY. The order client (src/paper/alpacaPaperClient.js) is hard-wired
//   to the Alpaca paper endpoint; there is NO live endpoint anywhere and
//   nothing here consumes config.liveTradingEnabled.
// - MANUAL ONLY: never part of npm test, startup, schedulers, or CI. One run,
//   then exit. No polling/scheduling/background jobs.
// - DRY RUN IS THE DEFAULT. An order is sent ONLY when --execute-paper is
//   explicitly supplied AND paper credentials are configured.
// - Equity long / market buy / whole shares only. No shorts, options, or margin.
// - SANITIZED OUTPUT ONLY: event id, ticker, model/prompt, numeric scores,
//   proposed side/qty, risk decision, and (if any) the order id/status. Never
//   raw model responses, raw payloads, API keys, headers, or request configs.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createAlpacaPaperClient } from '../src/paper/alpacaPaperClient.js';
import {
  assessProposal,
  insertPaperTrade,
  insertRejectedTrade,
  DEFAULT_QTY,
  MAX_QTY,
  DEFAULT_THRESHOLDS,
} from '../src/paper/paperTradeProposal.js';
import { MODEL_PROMPT_VERSION } from '../src/sentiment/modelClassifier.js';

// Re-export the proposal caps/defaults so callers (and tests) can read the
// script's effective limits without importing the proposal module directly.
export { DEFAULT_QTY, MAX_QTY, DEFAULT_THRESHOLDS };

/** Default allow-list when --symbols is omitted. */
const DEFAULT_SYMBOLS = ['AAPL'];

/** Parse a finite float in [0,1] for a threshold flag, else null (use default). */
function parseUnitFloat(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * Parse CLI args. Exported for tests. Conservative + capped: qty is clamped to
 * [1, MAX_QTY]; thresholds are only overridden by valid [0,1] floats; execute
 * is OFF unless --execute-paper is explicitly present.
 *   --symbols A,B  --qty N  --event-id N  --execute-paper
 *   --confidence-threshold f  --impact-threshold f  --sentiment-threshold f
 */
export function parseArgs(argv) {
  const args = {
    symbols: [...DEFAULT_SYMBOLS],
    qty: DEFAULT_QTY,
    eventId: null,
    executePaper: false,
    thresholds: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--symbols' && argv[i + 1]) {
      args.symbols = argv[i + 1].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      i += 1;
    } else if (flag === '--qty' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) args.qty = Math.min(n, MAX_QTY);
      i += 1;
    } else if (flag === '--event-id' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) args.eventId = n;
      i += 1;
    } else if (flag === '--confidence-threshold' && argv[i + 1]) {
      const f = parseUnitFloat(argv[i + 1]);
      if (f !== null) args.thresholds.minConfidence = f;
      i += 1;
    } else if (flag === '--impact-threshold' && argv[i + 1]) {
      const f = parseUnitFloat(argv[i + 1]);
      if (f !== null) args.thresholds.minImpact = f;
      i += 1;
    } else if (flag === '--sentiment-threshold' && argv[i + 1]) {
      const f = parseUnitFloat(argv[i + 1]);
      if (f !== null) args.thresholds.minSentiment = f;
      i += 1;
    } else if (flag === '--execute-paper') {
      args.executePaper = true;
    }
  }
  if (args.symbols.length === 0) args.symbols = [...DEFAULT_SYMBOLS];
  return args;
}

/**
 * Select ONE recent scored event for a paper proposal. Read-only; selects only
 * a WHITELIST of columns (never raw_response / detail / raw_payload). Defaults
 * to the real-model prompt version (model_v1) so the slice acts on real scores.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number|null} [opts.eventId]       explicit event id (still must be scored)
 * @param {string[]} [opts.allowedSymbols]   restrict to these tickers
 * @param {string} [opts.promptVersion]      default MODEL_PROMPT_VERSION
 * @returns {{ event: {id:number, ticker:string},
 *   score: object }|null}
 */
export function selectRecentScoredEvent(
  db,
  { eventId = null, allowedSymbols = [], promptVersion = MODEL_PROMPT_VERSION } = {}
) {
  const symbols = (allowedSymbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const conds = ['s.prompt_version = ?'];
  const params = [promptVersion];
  if (Number.isInteger(eventId) && eventId > 0) {
    conds.push('n.id = ?');
    params.push(eventId);
  }
  if (symbols.length > 0) {
    conds.push(`n.ticker IN (${symbols.map(() => '?').join(', ')})`);
    params.push(...symbols);
  }
  const row = db
    .prepare(
      `SELECT n.id AS event_id, n.ticker AS ticker,
              s.model AS model, s.prompt_version AS prompt_version,
              s.sentiment_score AS sentiment_score, s.impact_score AS impact_score,
              s.confidence AS confidence, s.direction AS direction,
              s.parser_status AS parser_status, s.news_type AS news_type
         FROM news_events n
         JOIN sentiment_scores s ON s.news_event_id = n.id
        WHERE ${conds.join(' AND ')}
        ORDER BY s.id DESC
        LIMIT 1`
    )
    .get(...params);
  if (!row) return null;
  return {
    event: { id: row.event_id, ticker: row.ticker },
    score: {
      model: row.model,
      prompt_version: row.prompt_version,
      sentiment_score: row.sentiment_score,
      impact_score: row.impact_score,
      confidence: row.confidence,
      direction: row.direction,
      parser_status: row.parser_status,
      news_type: row.news_type,
    },
  };
}

/**
 * Core one-shot logic, dependency-injected so tests run fully offline. Given a
 * selected { event, score }, it assesses the proposal and:
 *   - on REJECT: writes rejected_trades, returns the decision (no order, any mode);
 *   - on ACCEPT + dry run (default): writes NOTHING, returns a would-submit decision;
 *   - on ACCEPT + execute: submits a PAPER market order, writes paper_trades on
 *     success, or records a sanitized orderError on failure (no throw escapes).
 *
 * @param {object} db
 * @param {{event: object, score: object}} selected
 * @param {object} deps
 * @param {object|null} [deps.paperClient]   required only when executePaper
 * @param {number} [deps.qty]
 * @param {string[]} [deps.allowedSymbols]
 * @param {object} [deps.thresholds]
 * @param {boolean} [deps.executePaper]
 */
export async function runPaperTradeOnce(
  db,
  { event, score },
  { paperClient = null, qty = DEFAULT_QTY, allowedSymbols = [], thresholds = {}, executePaper = false } = {}
) {
  const proposal = assessProposal({ event, score, qty, allowedSymbols, thresholds });
  const result = {
    mode: executePaper ? 'execute_paper' : 'dry_run',
    proposal,
    decision: proposal.accepted ? 'accepted' : 'rejected',
    rejectedTradeId: null,
    paperTradeId: null,
    order: null,
    orderError: null,
  };

  if (!proposal.accepted) {
    const { id } = insertRejectedTrade(db, {
      newsEventId: proposal.eventId,
      ticker: proposal.ticker,
      side: proposal.side,
      quantity: proposal.quantity,
      reason: proposal.reason,
    });
    result.rejectedTradeId = id;
    return result;
  }

  // Accepted. In the default DRY RUN we stop here — nothing is sent or stored.
  if (!executePaper) return result;

  // Execute path. A missing client is a safe no-op failure (never an order).
  if (!paperClient) {
    result.orderError = 'paper client not configured — no order sent';
    return result;
  }

  try {
    const order = await paperClient.submitMarketOrder({
      symbol: proposal.ticker,
      qty: proposal.quantity,
      side: 'buy',
    });
    result.order = order;
    const { id } = insertPaperTrade(db, {
      newsEventId: proposal.eventId,
      ticker: proposal.ticker,
      side: 'buy',
      quantity: proposal.quantity,
      fillPrice: order.filledAvgPrice ?? null,
      entryAt: order.submittedAt ?? new Date().toISOString(),
      tradeReason: `${proposal.reason}; paper order ${order.id ?? '?'} status ${order.status ?? '?'}`,
      status: 'open',
    });
    result.paperTradeId = id;
  } catch (err) {
    // The client already sanitizes/redacts. Record the message; never the error
    // object, and never write paper_trades for a failed submit.
    result.orderError = err.message;
  }
  return result;
}

/** Build the sanitized report lines. Whitelist only — no raw text can leak. */
export function buildPaperReport(result, selected) {
  const p = result.proposal;
  const s = p.score;
  const lines = [
    'Paper trading one-shot (manual, PAPER-only — live trading disabled)',
    `  mode:       ${result.mode === 'execute_paper' ? 'EXECUTE PAPER' : 'DRY RUN (no order)'}`,
    `  event:      ${p.eventId ?? '?'} ${p.ticker || '(none)'}`,
    `  score:      model "${s.model ?? '?'}" prompt "${s.promptVersion ?? '?'}"  ` +
      `dir=${s.direction ?? '?'} status=${s.parserStatus ?? '?'} ` +
      `sentiment=${s.sentiment ?? '?'} impact=${s.impact ?? '?'} confidence=${s.confidence ?? '?'}`,
    `  proposal:   ${p.assetClass} ${p.side} qty ${p.quantity}`,
    `  decision:   ${result.decision.toUpperCase()} — ${p.reason}`,
  ];
  if (result.rejectedTradeId !== null) {
    lines.push(`  logged:     rejected_trades id ${result.rejectedTradeId}`);
  }
  if (result.order) {
    lines.push(
      `  order:      id ${result.order.id ?? '?'} status ${result.order.status ?? '?'}` +
        `${result.order.filledAvgPrice !== null ? ` filledAvgPrice ${result.order.filledAvgPrice}` : ''}`
    );
  }
  if (result.paperTradeId !== null) {
    lines.push(`  logged:     paper_trades id ${result.paperTradeId}`);
  }
  if (result.orderError) {
    lines.push(`  order error: ${result.orderError}`);
  }
  if (result.decision === 'accepted' && result.mode === 'dry_run') {
    lines.push('  (DRY RUN — pass --execute-paper to actually submit a PAPER order)');
  }
  return lines;
}

async function main() {
  const { symbols, qty, eventId, executePaper, thresholds } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db); // idempotent; ensures paper_trades / rejected_trades exist

    const selected = selectRecentScoredEvent(db, { eventId, allowedSymbols: symbols });
    if (!selected) {
      console.log(
        `No eligible scored event found (need a ${MODEL_PROMPT_VERSION} score on one of ` +
          `[${symbols.join(',')}]). Run the MVP pipeline / classifyNewsOnce with ` +
          '--classifier real_model first.'
      );
      return;
    }

    // Construct the paper client ONLY for an explicit execute run, and only with
    // credentials. Missing creds fails safely without sending anything.
    let paperClient = null;
    if (executePaper) {
      if (!config.alpacaPaper.keyId || !config.alpacaPaper.secretKey) {
        console.error(
          'Paper order NOT SENT: Alpaca PAPER credentials are not configured.\n' +
            'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your local .env\n' +
            '(see .env.example), or omit --execute-paper to dry-run.'
        );
        process.exitCode = 1;
        return;
      }
      paperClient = createAlpacaPaperClient(config);
    }

    const result = await runPaperTradeOnce(db, selected, {
      paperClient,
      qty,
      allowedSymbols: symbols,
      thresholds,
      executePaper,
    });
    for (const line of buildPaperReport(result, selected)) console.log(line);

    if (result.orderError) {
      console.log('Paper trading completed WITH AN ORDER ERROR (no paper_trades row written).');
      process.exitCode = 1;
    } else if (result.decision === 'accepted' && result.mode === 'execute_paper') {
      console.log('Paper trading COMPLETE (PAPER order submitted; paper_trades row written).');
    } else {
      console.log('Paper trading COMPLETE (no order placed).');
    }
  } catch (err) {
    // Source/client errors are sanitized at their origin; print the message
    // only, never the error object (it could embed request config).
    console.error(`Paper trading FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
