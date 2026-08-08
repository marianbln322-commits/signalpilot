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

// ---------------------------------------------------------------------------
// TWO KINDS OF ENTRY, AND WHY THEY MUST NOT BE MIXED
//
//   background:   one sample per closed bar, recorded whether or not anything
//                 alerted. Purpose: keep observing the market 24/7. This is the
//                 UNCONDITIONAL population — every bar with a direction.
//
//   alert:        a signal that actually passed the filters (sniper eligibility,
//                 session hours, freshness...). This is the population that gets
//                 TRADED, and therefore the only one whose win-rate describes
//                 what happens to your money. An alert may additionally be
//                 flagged `uncalibrated` when it fired in observation mode
//                 (shown, but not a recommendation) — it is still a real alert
//                 and still counts, because otherwise observation mode could
//                 never accumulate the evidence needed to leave observation mode.
//
// Mixing them poisons every estimate. Background samples outnumber alerts by
// roughly 60:1, so any average over the mixture converges to the unconditional
// base rate (~50% on a coin-flip horizon) with a very tight confidence interval.
// The result is not merely imprecise: it is confidently wrong, and it gets more
// confident the longer the app runs.
// ---------------------------------------------------------------------------

// Older journals used a single `observation` flag for both meanings. Split it:
// per-bar samples were keyed `obs-<symbol>-<candleOpen>`, so the id identifies them.
function migrate(rows) {
  let touched = false;
  for (const e of rows) {
    if (e.background === undefined) {
      const wasObs = !!e.observation;
      e.background = wasObs && typeof e.id === 'string' && e.id.startsWith('obs-');
      e.uncalibrated = wasObs && !e.background;
      touched = true;
    }
  }
  return touched;
}

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (Array.isArray(rows) && migrate(rows)) {
        try {
          fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
        } catch { /* migration is in-memory regardless */ }
      }
      return rows;
    }
  } catch (e) {
    console.error('Journal read error:', e.message);
  }
  return [];
}

// Entries that describe real, filtered signals — the only valid basis for
// calibration, sizing and learning. Excludes background bar samples.
const isAlert = (e) => !e.background;
const isResolvedAlert = (e) => e.status === 'resolved' && !e.background;

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
  // `background` = per-bar observation sample. Fall back to the legacy
  // `observation` flag only when a candleOpen is present, which is what the
  // old per-bar recorder always supplied.
  const isBackground = sig.background != null
    ? !!sig.background
    : (!!sig.observation && sig.candleOpen != null);
  // Background samples are deduped per bar per symbol; real alerts per timestamp.
  const id = isBackground ? `obs-${sig.symbol}-${sig.candleOpen}` : `${sig.ts}-${sig.symbol}`;
  if (entries.some((e) => e.id === id)) return null;
  const entry = {
    id,
    background: isBackground,   // true = 24/7 bar sample, NOT a tradable alert
    // A real alert that fired while the model was still uncalibrated: displayed
    // for observation only, but a genuine alert that must be measured.
    uncalibrated: !isBackground && !!(sig.uncalibrated || sig.observation),
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
  // Keep a large buffer for learning; evict the oldest BACKGROUND sample first so
  // real alerts — which accrue ~60x slower and carry all the signal — survive.
  if (entries.length > 8000) {
    const idx = entries.map((e, i) => [e, i]).reverse().find(([e]) => e.background);
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
      // TIE = REFUND, not a loss.
      //
      // This used to record a dead-flat outcome as a loss, reasoning that the
      // pessimistic reading is the safe one. A 506-position audit of real MEXC
      // settlements showed that is simply wrong: on every exact tie the payout
      // returned was equal to the stake — the position is voided and the money
      // comes back. Grading a refund as a loss biases the measured win-rate
      // DOWNWARD, which then feeds calibration and the EV gate. Being wrong in
      // the "safe" direction is still being wrong.
      //
      // Ties are therefore void: win is null and they are excluded from every
      // win-rate, while remaining visible in the journal.
      e.tie = price === e.entryPrice;
      e.win = e.tie ? null : (e.directie === 'UP' ? price > e.entryPrice : price < e.entryPrice);
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

// Ties are refunds, so they are void: excluded from the denominator rather than
// counted as losses. Reported separately so they never just vanish.
function agg(arr) {
  const graded = arr.filter((e) => e.win === true || e.win === false);
  const n = graded.length;
  const w = graded.filter((e) => e.win).length;
  return {
    n,
    wins: w,
    ties: arr.length - n,
    winRate: n ? +((w / n) * 100).toFixed(1) : null,
  };
}

// Recent win-rate split by contract window (newest first). Used by the adaptive
// interval controller: when 10-min degrades, the engine shifts toward 30-min.
function recentByInterval(limit = 20) {
  // Real alerts only: this drives interval choice, so it must reflect the
  // population that gets traded, not every bar the app looked at.
  const resolved = entries.filter(isResolvedAlert);
  const ten = resolved.filter((e) => e.interval === '10 minute').slice(0, limit);
  const thirty = resolved.filter((e) => e.interval === '30 minute').slice(0, limit);
  return { tenMin: agg(ten), thirtyMin: agg(thirty) };
}

// Resolved real alerts, shaped for the calibration layer. This is deliberately
// the ONLY sample source callers should use to estimate win probability.
function samples() {
  return entries
    // Ties carry no directional information (the money came back), so they must
    // not enter calibration in either direction.
    .filter((e) => isResolvedAlert(e) && e.setup && e.interval && typeof e.win === 'boolean')
    .map((e) => ({
      setup: e.setup,
      interval: e.interval,
      score: e.score,
      probability: e.probability,
      win: e.win,
    }));
}

// Background-sample statistics, kept separate so the UI can still show what the
// 24/7 observer learned without letting it contaminate trade estimates.
function backgroundStats() {
  const resolved = entries.filter((e) => e.background && e.status === 'resolved');
  return {
    overall: agg(resolved),
    byInterval: {
      '10 minute': agg(resolved.filter((e) => e.interval === '10 minute')),
      '30 minute': agg(resolved.filter((e) => e.interval === '30 minute')),
    },
    note: 'eșantioane per bară (toate barele, nefiltrate) — bază de comparație, NU performanță tranzacționabilă',
  };
}

function stats() {
  // Trade stats reflect only real alerts (not background bar samples).
  const resolved = entries.filter(isResolvedAlert);
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
    // Alerts shown for observation only (model not yet calibrated). They are
    // included in the win-rate above on purpose — they are real signals.
    uncalibratedAlerts: agg(resolved.filter((e) => e.uncalibrated)),
    background: backgroundStats(),
    pending: entries.filter((e) => e.status === 'pending').length,
    totalAlerts: entries.filter(isAlert).length,
    total: entries.length,
  };
}

function recent(limit = 40) {
  // Only show real alerts in the journal list, not background bar samples.
  return entries.filter(isAlert).slice(0, limit);
}

function reset() {
  entries = [];
  save();
}

module.exports = {
  record,
  resolvePending,
  stats,
  recent,
  recentByInterval,
  samples,
  backgroundStats,
  reset,
  all: () => entries,
};
