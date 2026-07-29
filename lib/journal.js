'use strict';

// ============================================================================
// journal.js — automatic forward-testing log.
// Every alert is recorded with its entry price and a resolve time (entry + the
// contract window). A background resolver later fetches the price and marks
// win/loss AUTOMATICALLY. This gives a true, hands-off live win-rate — the only
// honest way to validate the strategy before risking real money.
// ============================================================================

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'journal.json');
let entries = load();

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('Journal read error:', e.message);
  }
  return [];
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.error('Journal write error:', e.message);
  }
}

// Record a new signal. Returns the created entry (or null if a duplicate).
function record(sig) {
  const horizonMin = sig.interval === '10 minute' ? 10 : 30;
  const isObs = !!sig.observation;
  // Observations are deduped per 5m candle per symbol; real alerts per timestamp.
  const id = isObs ? `obs-${sig.symbol}-${sig.candleOpen}` : `${sig.ts}-${sig.symbol}`;
  if (entries.some((e) => e.id === id)) return null;
  const entry = {
    id,
    observation: isObs, // true = background learning sample, not a real alert
    symbol: sig.symbol,
    directie: sig.directie,
    interval: sig.interval,
    incredere: sig.incredere,
    sniper: !!sig.sniper,
    // Rich context for the learning layer:
    setup: sig.setup || null,        // primary trigger category
    // Raw confluence score, kept so the calibration layer can bucket by it.
    score: sig.score != null ? sig.score : null,
    // What the model believed at signal time — needed to check calibration
    // afterwards ("did the 62% signals actually win 62% of the time?").
    probability: sig.probability != null ? sig.probability : null,
    stake: sig.stake != null ? sig.stake : null,
    hourUTC: sig.hourUTC != null ? sig.hourUTC : new Date(sig.ts).getUTCHours(),
    ofState: sig.ofState || null,    // order-flow state: buy/sell/neutru
    ofAgree: sig.ofAgree || null,    // confirmă/conflict/neutru vs direction
    entryPrice: sig.price,
    entryTs: sig.ts,
    resolveTs: sig.ts + horizonMin * 60 * 1000,
    status: 'pending',
    exitPrice: null,
    win: null,
  };
  entries.unshift(entry);
  // Keep a large buffer for learning; drop oldest observation first so real
  // alerts are preserved as long as possible.
  if (entries.length > 8000) {
    const idx = entries.map((e, i) => [e, i]).reverse().find(([e]) => e.observation);
    if (idx) entries.splice(idx[1], 1);
    else entries.pop();
  }
  save();
  return entry;
}

// Resolve any pending entries whose window has elapsed.
//
// `settle(symbol, resolveTs)` must return either a number or
// { price, method, samples }. It is expected to produce a TIME-WEIGHTED AVERAGE
// over the seconds immediately before expiry, because that is how MEXC states
// Up/Down settlement prices are determined. Grading against a single tick — what
// this function used to do — measures a different outcome from the one that
// actually pays, and a late wick can flip it either way.
async function resolvePending(settle, opts = {}) {
  const now = Date.now();
  // Small grace period so the settlement window has samples in it before we read.
  const graceMs = opts.graceMs != null ? opts.graceMs : 5000;
  const resolved = [];
  let changed = false;
  for (const e of entries) {
    if (e.status !== 'pending' || now < e.resolveTs + graceMs) continue;
    try {
      const out = await settle(e.symbol, e.resolveTs);
      const price = typeof out === 'number' ? out : (out && out.price);
      if (!Number.isFinite(price)) continue;
      e.exitPrice = price;
      e.settlement = typeof out === 'object' && out
        ? { method: out.method, samples: out.samples }
        : { method: 'last-price', samples: 1 };
      // A dead-flat outcome is not a win. MEXC does not publish its tie rule for
      // these contracts, so the pessimistic reading is used deliberately: this
      // is a self-grading journal, and flattering yourself here costs money.
      e.win = e.directie === 'UP' ? price > e.entryPrice : price < e.entryPrice;
      e.tie = price === e.entryPrice;
      e.status = 'resolved';
      changed = true;
      resolved.push(e);
    } catch {
      /* try again next cycle */
    }
  }
  if (changed) save();
  return resolved;
}

function agg(arr) {
  const n = arr.length;
  const w = arr.filter((e) => e.win).length;
  return { n, wins: w, winRate: n ? +((w / n) * 100).toFixed(1) : null };
}

// Recent win-rate split by contract window (newest first). Used by the adaptive
// interval controller: when 10-min degrades, the engine shifts toward 30-min.
function recentByInterval(limit = 20) {
  const resolved = entries.filter((e) => e.status === 'resolved');
  const ten = resolved.filter((e) => e.interval === '10 minute').slice(0, limit);
  const thirty = resolved.filter((e) => e.interval === '30 minute').slice(0, limit);
  return { tenMin: agg(ten), thirtyMin: agg(thirty) };
}

function stats() {
  // Trade stats reflect only real alerts (not background observations).
  const resolved = entries.filter((e) => e.status === 'resolved' && !e.observation);
  const symbols = [...new Set(resolved.map((e) => e.symbol))];
  const ri = recentByInterval(20);
  return {
    overall: agg(resolved),
    sniper: agg(resolved.filter((e) => e.sniper)),
    nonSniper: agg(resolved.filter((e) => !e.sniper)),
    bySymbol: Object.fromEntries(symbols.map((s) => [s, agg(resolved.filter((e) => e.symbol === s))])),
    sniperBySymbol: Object.fromEntries(symbols.map((s) => [s, agg(resolved.filter((e) => e.symbol === s && e.sniper))])),
    byInterval: {
      '10 minute': agg(resolved.filter((e) => e.interval === '10 minute')),
      '30 minute': agg(resolved.filter((e) => e.interval === '30 minute')),
    },
    recentInterval: ri,
    pending: entries.filter((e) => e.status === 'pending').length,
    total: entries.length,
  };
}

function recent(limit = 40) {
  // Only show real alerts in the journal list, not background observations.
  return entries.filter((e) => !e.observation).slice(0, limit);
}

function reset() {
  entries = [];
  save();
}

module.exports = { record, resolvePending, stats, recent, recentByInterval, reset, all: () => entries };
