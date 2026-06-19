// scripts/runPaperTradingOnce.js — MANUAL one-shot PAPER trade (Phase 5
// advanced: long/short equity + options + margin-aware risk).
//
//   Dry run (default; NO order):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT \
//       --classifier real_model --allow-shorts --allow-options --options-mode plan_only
//
//   Execute PAPER orders (requires Alpaca paper creds in .env):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL --execute-paper
//
// FLOW: select ONE recent real-model-scored event -> build an EQUITY proposal
// (long on up / short on down when --allow-shorts) AND, if --allow-options, an
// OPTION proposal (buy call/put by explicit OCC --option-symbol) -> margin-aware
// risk gate (account snapshot + caps) -> DRY RUN reports only; --execute-paper
// submits PAPER orders -> persist paper_trades (filled) / rejected_trades
// (refused) -> sanitized report.
//
// HARD SAFETY:
// - PAPER ONLY. The order client is hard-wired to the Alpaca paper endpoint;
//   no live endpoint exists and nothing consumes config.liveTradingEnabled.
// - DRY RUN IS THE DEFAULT. Orders go out ONLY with --execute-paper AND creds.
//   Options additionally need --allow-options + --options-mode execute_paper +
//   a verified account options capability + an explicit --option-symbol.
// - No uncapped trading: qty/contract caps + margin-aware notional/exposure/
//   daily caps. No spreads, no multi-leg, no uncovered option writing.
// - SANITIZED OUTPUT ONLY. Never raw model responses, raw payloads, API keys,
//   headers, request configs, or webhook URLs.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createAlpacaPaperClient } from '../src/paper/alpacaPaperClient.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';
import {
  assessProposal,
  insertPaperTrade,
  insertRejectedTrade,
  DEFAULT_QTY,
  MAX_QTY,
  DEFAULT_THRESHOLDS,
} from '../src/paper/paperTradeProposal.js';
import { proposeOption, DEFAULT_OPTION_CONTRACT_LIMIT } from '../src/paper/optionsProposal.js';
import { assessRisk, resolveCaps, DEFAULT_CAPS } from '../src/paper/paperRisk.js';
import { deriveCapabilities, summarizeCapabilities } from '../src/paper/accountCapabilities.js';
import { MODEL_PROMPT_VERSION } from '../src/sentiment/modelClassifier.js';

export { DEFAULT_QTY, MAX_QTY, DEFAULT_THRESHOLDS, DEFAULT_CAPS };

const DEFAULT_SYMBOLS = ['AAPL'];
const OPTIONS_MODES = new Set(['plan_only', 'execute_paper']);

/** Reference-price lookup window (free IEX feed is restricted for very recent data). */
const REF_PRICE_LAG_MIN = 16;
const REF_PRICE_SPAN_MIN = 10;

function parseUnitFloat(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
function parsePosNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function parsePosInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parse CLI args. Exported for tests. Every numeric value is validated; unknown
 * flags are ignored; execution stays OFF unless --execute-paper is present.
 */
export function parseArgs(argv) {
  const args = {
    symbols: [...DEFAULT_SYMBOLS],
    qty: DEFAULT_QTY,
    eventId: null,
    executePaper: false,
    allowShorts: false,
    allowOptions: false,
    optionsMode: 'plan_only',
    optionSymbol: null,
    optionExpiryDaysMin: null,
    optionExpiryDaysMax: null,
    optionMaxPremium: null,
    optionContractLimit: DEFAULT_OPTION_CONTRACT_LIMIT,
    thresholds: {},
    caps: {},
  };
  const setThresh = (key, v) => { const f = parseUnitFloat(v); if (f !== null) args.thresholds[key] = f; };
  const setCap = (key, v) => { const n = parsePosNum(v); if (n !== null) args.caps[key] = n; };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--symbols' && next) {
      args.symbols = next.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      i += 1;
    } else if (flag === '--qty' && next) {
      args.qty = Math.min(parsePosInt(next) ?? DEFAULT_QTY, MAX_QTY); i += 1;
    } else if (flag === '--event-id' && next) {
      args.eventId = parsePosInt(next); i += 1;
    } else if (flag === '--confidence-threshold' && next) { setThresh('minConfidence', next); i += 1; }
    else if (flag === '--impact-threshold' && next) { setThresh('minImpact', next); i += 1; }
    else if (flag === '--sentiment-threshold' && next) { setThresh('minSentiment', next); i += 1; }
    else if (flag === '--allow-shorts') { args.allowShorts = true; }
    else if (flag === '--allow-options') { args.allowOptions = true; }
    else if (flag === '--options-mode' && next) {
      if (OPTIONS_MODES.has(next.trim())) args.optionsMode = next.trim(); i += 1;
    } else if (flag === '--option-symbol' && next) { args.optionSymbol = next.trim().toUpperCase(); i += 1; }
    else if (flag === '--option-expiry-days-min' && next) { args.optionExpiryDaysMin = parsePosInt(next); i += 1; }
    else if (flag === '--option-expiry-days-max' && next) { args.optionExpiryDaysMax = parsePosInt(next); i += 1; }
    else if (flag === '--option-max-premium' && next) {
      const n = parsePosNum(next); if (n !== null) { args.optionMaxPremium = n; args.caps.maxOptionPremium = n; } i += 1;
    } else if (flag === '--option-contract-limit' && next) {
      args.optionContractLimit = parsePosInt(next) ?? DEFAULT_OPTION_CONTRACT_LIMIT; i += 1;
    } else if (flag === '--max-order-notional' && next) { setCap('maxOrderNotional', next); i += 1; }
    else if (flag === '--max-symbol-exposure' && next) { setCap('maxSymbolExposure', next); i += 1; }
    else if (flag === '--max-gross-exposure' && next) { setCap('maxGrossExposure', next); i += 1; }
    else if (flag === '--max-daily-paper-orders' && next) { setCap('maxDailyPaperOrders', next); i += 1; }
    else if (flag === '--max-daily-paper-notional' && next) { setCap('maxDailyPaperNotional', next); i += 1; }
    else if (flag === '--execute-paper') { args.executePaper = true; }
  }
  if (args.symbols.length === 0) args.symbols = [...DEFAULT_SYMBOLS];
  return args;
}

/** Select ONE recent scored event (whitelisted columns only). */
export function selectRecentScoredEvent(
  db,
  { eventId = null, allowedSymbols = [], promptVersion = MODEL_PROMPT_VERSION } = {}
) {
  const symbols = (allowedSymbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const conds = ['s.prompt_version = ?'];
  const params = [promptVersion];
  if (Number.isInteger(eventId) && eventId > 0) { conds.push('n.id = ?'); params.push(eventId); }
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
      model: row.model, prompt_version: row.prompt_version,
      sentiment_score: row.sentiment_score, impact_score: row.impact_score,
      confidence: row.confidence, direction: row.direction,
      parser_status: row.parser_status, news_type: row.news_type,
    },
  };
}

/** Today's paper-order counters from the DB, for daily caps. Read-only. */
export function getDailyCounters(db, day = new Date().toISOString().slice(0, 10)) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(COALESCE(fill_price,0)*quantity),0) AS notional
         FROM paper_trades WHERE substr(created_at,1,10) = ?`
    )
    .get(day);
  return { orders: Number(row?.orders ?? 0), notional: Number(row?.notional ?? 0) };
}

/** Map a proposal to the shape paperRisk expects. */
function riskShape(proposal, kind) {
  return kind === 'option'
    ? { assetClass: 'option', side: 'buy', ticker: proposal.underlying, quantity: proposal.contracts }
    : { assetClass: 'equity', side: proposal.side, ticker: proposal.ticker, quantity: proposal.quantity };
}

/**
 * Process ONE proposal through risk + (dry-run|execute) + persistence. Never
 * throws on a submit failure — records a sanitized orderError instead.
 */
async function processProposal(db, proposal, ctx) {
  const {
    kind, capabilities, account, positions, caps, daily, referencePrice,
    executePaper, paperClient, planOnly = false,
  } = ctx;
  const sub = {
    kind, proposal, risk: null, decision: 'rejected',
    rejectedTradeId: null, paperTradeId: null, order: null, orderError: null,
  };

  // Score/intent gate already decided acceptance.
  if (!proposal.accepted) {
    sub.rejectedTradeId = insertRejectedTrade(db, {
      newsEventId: proposal.eventId,
      ticker: proposal.underlying ?? proposal.ticker,
      side: kind === 'option' ? 'buy' : proposal.side,
      quantity: proposal.contracts ?? proposal.quantity ?? null,
      reason: proposal.reason,
    }).id;
    return sub;
  }

  // Margin-aware risk gate (run when we have an account snapshot, or when we are
  // about to execute — a real order is never sent without a risk pass).
  const haveAccount = Boolean(capabilities && capabilities.available);
  if (haveAccount || executePaper) {
    sub.risk = assessRisk({
      proposal: riskShape(proposal, kind),
      capabilities: capabilities ?? { available: false },
      account, positions, caps, daily, referencePrice, executePaper,
    });
    if (!sub.risk.approved) {
      sub.rejectedTradeId = insertRejectedTrade(db, {
        newsEventId: proposal.eventId,
        ticker: proposal.underlying ?? proposal.ticker,
        side: kind === 'option' ? 'buy' : proposal.side,
        quantity: proposal.contracts ?? proposal.quantity ?? null,
        reason: sub.risk.reason,
      }).id;
      return sub;
    }
  }

  sub.decision = 'accepted';
  if (planOnly) { sub.decision = 'plan'; return sub; } // options plan_only never executes
  if (!executePaper) return sub; // dry run: nothing sent or stored
  if (!paperClient) { sub.orderError = 'paper client not configured — no order sent'; return sub; }

  try {
    const order =
      kind === 'option'
        ? await paperClient.submitOptionMarketOrder({ optionSymbol: proposal.optionSymbol, qty: proposal.contracts, side: 'buy' })
        : await paperClient.submitMarketOrder({ symbol: proposal.ticker, qty: proposal.quantity, side: proposal.side });
    sub.order = order;
    sub.paperTradeId = insertPaperTrade(db, {
      newsEventId: proposal.eventId,
      ticker: proposal.underlying ?? proposal.ticker,
      side: kind === 'option' ? 'buy' : proposal.side,
      quantity: proposal.contracts ?? proposal.quantity,
      fillPrice: order.filledAvgPrice ?? null,
      entryAt: order.submittedAt ?? new Date().toISOString(),
      tradeReason:
        (kind === 'option' ? `[option ${proposal.intent} ${proposal.optionSymbol}] ` : '') +
        `${proposal.reason}; paper order ${order.id ?? '?'} status ${order.status ?? '?'}`,
      status: 'open',
    }).id;
  } catch (err) {
    sub.orderError = err.message; // already sanitized by the client
  }
  return sub;
}

/**
 * Core one-shot logic, dependency-injected so tests run fully offline. Account/
 * positions/capabilities/referencePrice/daily are passed in; the script's
 * main()/loop fetch them from the real clients.
 */
export async function runPaperTradeOnce(db, { event, score }, deps = {}) {
  const {
    paperClient = null, qty = DEFAULT_QTY, allowedSymbols = [], thresholds = {}, allowShorts = false,
    allowOptions = false, optionsMode = 'plan_only', optionSymbol = null, optionMaxPremium = null,
    optionContractLimit = DEFAULT_OPTION_CONTRACT_LIMIT, optionExpiryDaysMin = null, optionExpiryDaysMax = null,
    caps = {}, account = null, positions = [], capabilities = null, referencePrice = null,
    optionReferencePrice = null, daily = { orders: 0, notional: 0 }, executePaper = false, nowMs = Date.now(),
  } = deps;

  const result = {
    mode: executePaper ? 'execute_paper' : 'dry_run',
    capabilities: capabilities ? summarizeCapabilities(capabilities) : null,
    referencePrice,
    equity: null,
    option: null,
  };

  const equityProposal = assessProposal({ event, score, qty, allowedSymbols, thresholds, allowShorts });
  result.equity = await processProposal(db, equityProposal, {
    kind: 'equity', capabilities, account, positions, caps, daily, referencePrice, executePaper, paperClient,
  });

  const optionProposal = proposeOption({
    event, score, allowOptions, optionsMode, optionSymbol, allowedSymbols, thresholds,
    optionContractLimit, optionExpiryDaysMin, optionExpiryDaysMax, optionMaxPremium, nowMs,
  });
  if (optionProposal.enabled) {
    result.option = await processProposal(db, optionProposal, {
      kind: 'option', capabilities, account, positions, caps, daily,
      referencePrice: optionReferencePrice, executePaper, paperClient, planOnly: optionProposal.planOnly,
    });
  } else {
    result.option = {
      kind: 'option', proposal: optionProposal, risk: null, decision: 'disabled',
      rejectedTradeId: null, paperTradeId: null, order: null, orderError: null,
    };
  }
  return result;
}

/** Best-effort latest reference price via the existing trades source. null on any issue. */
export async function fetchReferencePrice(priceSource, symbol, nowMs = Date.now()) {
  if (!priceSource) return null;
  try {
    const toMs = nowMs - REF_PRICE_LAG_MIN * 60_000;
    const fromMs = toMs - REF_PRICE_SPAN_MIN * 60_000;
    const trades = await priceSource.getTradesAround(symbol, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
    if (Array.isArray(trades) && trades.length > 0) return trades[trades.length - 1].price ?? null;
  } catch {
    /* sanitized: a price lookup failure just yields null (risk fail-safe handles it) */
  }
  return null;
}

/**
 * Fetch account + positions and derive capabilities. Best-effort: returns nulls
 * if the client is absent or the calls fail (sanitized). No throw escapes.
 */
export async function fetchAccountState(paperClient) {
  if (!paperClient) return { account: null, positions: [], capabilities: deriveCapabilities(null) };
  let account = null;
  let positions = [];
  try { account = await paperClient.getAccount(); } catch { account = null; }
  try { positions = await paperClient.getPositions(); } catch { positions = []; }
  return { account, positions, capabilities: deriveCapabilities(account) };
}

/** One short sanitized summary line per asset class, for loop heartbeats. */
export function oneLineSummary(result) {
  const e = result.equity;
  const eqTxt = `equity ${e?.proposal?.side ?? '?'} ${e?.decision ?? '?'}`;
  let opTxt = 'option off';
  if (result.option && result.option.decision !== 'disabled') {
    opTxt = `option ${result.option.proposal?.intent ?? '?'} ${result.option.decision}`;
  }
  return `${eqTxt}; ${opTxt}`;
}

function subLines(label, sub) {
  if (!sub) return [];
  if (sub.decision === 'disabled') return [`  ${label}:     disabled (--allow-options not set)`];
  const p = sub.proposal;
  const lines = [
    `  ${label}:     ${sub.decision.toUpperCase()} — ${p.reason}`,
  ];
  if (sub.risk) lines.push(`    risk:       ${sub.risk.approved ? 'approved' : 'REJECTED'} — ${sub.risk.reason} (est notional ${sub.risk.estNotional ?? 'n/a'})`);
  if (sub.rejectedTradeId !== null) lines.push(`    logged:     rejected_trades id ${sub.rejectedTradeId}`);
  if (sub.order) lines.push(`    order:      id ${sub.order.id ?? '?'} status ${sub.order.status ?? '?'}${sub.order.filledAvgPrice !== null ? ` filledAvgPrice ${sub.order.filledAvgPrice}` : ''}`);
  if (sub.paperTradeId !== null) lines.push(`    logged:     paper_trades id ${sub.paperTradeId}`);
  if (sub.orderError) lines.push(`    order error: ${sub.orderError}`);
  return lines;
}

/** Build the sanitized report lines. Whitelist only — no raw text can leak. */
export function buildPaperReport(result, selected) {
  const cap = result.capabilities;
  const s = result.equity?.proposal?.score ?? {};
  const lines = [
    'Paper trading one-shot (manual, PAPER-only — live trading disabled)',
    `  mode:       ${result.mode === 'execute_paper' ? 'EXECUTE PAPER' : 'DRY RUN (no order)'}`,
    `  account:    ${cap
      ? `equity=${cap.equity ?? '?'} buyingPower=${cap.buyingPower ?? '?'} mult=${cap.multiplier ?? '?'} ` +
        `short=${cap.shortEligible ? 'yes' : 'no'} options=${cap.optionsEligible ? `L${cap.optionsLevel}` : 'no'}` +
        `${cap.blocked ? ' BLOCKED' : ''}`
      : '(not fetched — dry run without paper credentials)'}`,
    `  event:      ${selected?.event?.id ?? '?'} ${selected?.event?.ticker ?? '(none)'}`,
    `  score:      model "${s.model ?? '?'}" prompt "${s.promptVersion ?? '?'}"  ` +
      `dir=${s.direction ?? '?'} status=${s.parserStatus ?? '?'} ` +
      `sentiment=${s.sentiment ?? '?'} impact=${s.impact ?? '?'} confidence=${s.confidence ?? '?'}`,
  ];
  lines.push(...subLines('equity', result.equity));
  lines.push(...subLines('option', result.option));
  if (result.mode === 'dry_run') {
    lines.push('  (DRY RUN — pass --execute-paper to actually submit PAPER orders)');
  }
  return lines;
}

/**
 * High-level one-shot used by BOTH the script main() and the loop: select an
 * event, fetch account state + a reference price from the injected clients, and
 * run the trade logic. Returns { selected, result, lines }.
 */
export async function executeOneShot(db, { args, paperClient = null, priceSource = null, nowMs = Date.now() }) {
  const selected = selectRecentScoredEvent(db, { eventId: args.eventId, allowedSymbols: args.symbols });
  if (!selected) {
    return { selected: null, result: null, lines: [
      `No eligible scored event found (need a ${MODEL_PROMPT_VERSION} score on one of [${args.symbols.join(',')}]).`,
    ] };
  }
  const { account, positions, capabilities } = await fetchAccountState(paperClient);
  const referencePrice = await fetchReferencePrice(priceSource, selected.event.ticker, nowMs);
  const daily = getDailyCounters(db);
  const result = await runPaperTradeOnce(db, selected, {
    paperClient, account, positions, capabilities, referencePrice,
    daily, nowMs,
    qty: args.qty, allowedSymbols: args.symbols, thresholds: args.thresholds, allowShorts: args.allowShorts,
    allowOptions: args.allowOptions, optionsMode: args.optionsMode, optionSymbol: args.optionSymbol,
    optionMaxPremium: args.optionMaxPremium, optionContractLimit: args.optionContractLimit,
    optionExpiryDaysMin: args.optionExpiryDaysMin, optionExpiryDaysMax: args.optionExpiryDaysMax,
    caps: args.caps, executePaper: args.executePaper,
  });
  return { selected, result, lines: buildPaperReport(result, selected) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db);

    const hasCreds = Boolean(config.alpacaPaper.keyId && config.alpacaPaper.secretKey);
    if (args.executePaper && !hasCreds) {
      console.error(
        'Paper order NOT SENT: Alpaca PAPER credentials are not configured.\n' +
          'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your local .env, or omit --execute-paper.'
      );
      process.exitCode = 1;
      return;
    }
    // Construct clients only when credentialed (account snapshot + reference
    // price improve dry-run reporting too, but require keys).
    const paperClient = hasCreds ? createAlpacaPaperClient(config) : null;
    const priceSource = hasCreds ? createAlpacaTradesPriceSource(config) : null;

    const { lines, result } = await executeOneShot(db, { args, paperClient, priceSource });
    for (const line of lines) console.log(line);
    if (!result) return;

    const orderErr = result.equity?.orderError || result.option?.orderError;
    if (orderErr) {
      console.log('Paper trading completed WITH AN ORDER ERROR (see above).');
      process.exitCode = 1;
    } else {
      console.log('Paper trading COMPLETE (research/paper-only; no live trading).');
    }
  } catch (err) {
    console.error(`Paper trading FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
