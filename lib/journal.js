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
const SETTLEMENT_GRACE_MS = 5 * 60 * 1000;
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
  // Observations are deduped per exact horizon boundary and symbol; real alerts per timestamp.
  const id = isObs
    ? `obs-v${Number.isInteger(sig.calibrationVersion) ? sig.calibrationVersion : 0}-${sig.symbol}-${sig.interval}-${sig.candleOpen}`
    : `${sig.ts}-${sig.symbol}`;
  if (entries.some((e) => e.id === id)) return null;
  const entry = {
    id,
    observation: isObs, // true = background learning sample, not a real alert
    calibrationVersion: Number.isInteger(sig.calibrationVersion) ? sig.calibrationVersion : null,
    entrySource: sig.entrySource || null,
    settlementSource: null,
    symbol: sig.symbol,
    directie: sig.directie,
    interval: sig.interval,
    incredere: sig.incredere,
    sniper: !!sig.sniper,
    // Rich context for the learning layer:
    setup: sig.setup || null,        // primary trigger category
    hourUTC: sig.hourUTC != null ? sig.hourUTC : new Date(sig.ts).getUTCHours(),
    ofState: sig.ofState || null,    // order-flow state: buy/sell/neutru
    ofAgree: sig.ofAgree || null,    // confirmă/conflict/neutru vs direction
    entryPrice: sig.price,
    horizon: Number.isFinite(sig.horizon) ? sig.horizon : horizonMin,
    action: sig.action || null,
    signalClass: sig.signalClass || null,
    calibrated: !!sig.calibrated,
    calibrationSource: sig.calibrationSource || null,
    probability: Number.isFinite(sig.probability) ? sig.probability : null,
    probabilityUp: Number.isFinite(sig.probabilityUp) ? sig.probabilityUp : null,
    probabilityDown: Number.isFinite(sig.probabilityDown) ? sig.probabilityDown : null,
    technicalConfidence: Number.isFinite(sig.technicalConfidence) ? sig.technicalConfidence : null,
    setupValid: !!sig.setupValid,
    breakEven: Number.isFinite(sig.breakEven) ? sig.breakEven : null,
    qualityFloor: Number.isFinite(sig.qualityFloor) ? sig.qualityFloor : null,
    requiredProbability: Number.isFinite(sig.requiredProbability) ? sig.requiredProbability : null,
    reliabilityLowerBound: Number.isFinite(sig.reliabilityLowerBound) ? sig.reliabilityLowerBound : null,
    calibrationSampleSize: Number.isInteger(sig.calibrationSampleSize) ? sig.calibrationSampleSize : null,
    calibrationRequired: Number.isInteger(sig.calibrationRequired) ? sig.calibrationRequired : null,
    calibrationRemaining: Number.isInteger(sig.calibrationRemaining) ? sig.calibrationRemaining : null,
    expectedValue: Number.isFinite(sig.expectedValue) ? sig.expectedValue : null,
    stake: Number.isFinite(sig.stake) && sig.stake > 0 ? sig.stake : 0,
    payoutPct: Number.isFinite(sig.payoutPct) && sig.payoutPct >= 0 ? sig.payoutPct : 0,
    pnl: null,
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

// Resolve pending entries at their exact target. Missing settlement trades are
// retried for five minutes, then marked VOID without outcome, P&L or learning.
async function resolvePending(getPrice) {
  const now = Date.now();
  const resolved = [];
  let changed = false;
  for (const e of entries) {
    if (e.status === 'pending' && now >= e.resolveTs) {
      try {
        const p = await getPrice(e.symbol, e.resolveTs);
        if (!Number.isFinite(p)) throw new Error('invalid settlement price');
        e.exitPrice = p;
        e.win = e.directie === 'UP' ? p > e.entryPrice : p < e.entryPrice;
        e.pnl = e.stake > 0 ? (e.win ? e.stake * e.payoutPct / 100 : -e.stake) : 0;
        e.status = 'resolved';
        e.settlementSource = 'aggTrade-exact';
        delete e.settlementError;
        changed = true;
        resolved.push(e);
      } catch (error) {
        e.settlementError = error && error.message ? error.message : 'settlement unavailable';
        if (now >= e.resolveTs + SETTLEMENT_GRACE_MS) {
          e.status = 'void';
          e.exitPrice = null;
          e.win = null;
          e.pnl = null;
          changed = true;
          resolved.push(e);
        }
      }
    }
  }
  if (changed) save();
  return resolved;
}

function agg(arr) {
  const n = arr.length;
  const w = arr.filter((e) => e.win).length;
  const pnl = arr.reduce((sum, entry) => sum + (Number.isFinite(entry.pnl) ? entry.pnl : 0), 0);
  return {
    n,
    wins: w,
    winRate: n ? +((w / n) * 100).toFixed(1) : null,
    pnl: +pnl.toFixed(2),
  };
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
  // Trade stats reflect only visible paper/validated alerts, never background observations.
  const resolved = entries.filter((e) => e.status === 'resolved' && !e.observation);
  const validated = resolved.filter((e) => e.signalClass === 'validated-trade');
  const technicalPaper = resolved.filter((e) => e.signalClass === 'technical-paper');
  const symbols = [...new Set(resolved.map((e) => e.symbol))];
  const ri = recentByInterval(20);
  return {
    overall: agg(resolved),
    validated: agg(validated),
    technicalPaper: agg(technicalPaper),
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
    void: entries.filter((e) => e.status === 'void').length,
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
