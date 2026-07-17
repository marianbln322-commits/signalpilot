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
  const id = `${sig.ts}-${sig.symbol}`;
  if (entries.some((e) => e.id === id)) return null;
  const entry = {
    id,
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
    entryTs: sig.ts,
    resolveTs: sig.ts + horizonMin * 60 * 1000,
    status: 'pending',
    exitPrice: null,
    win: null,
  };
  entries.unshift(entry);
  if (entries.length > 2000) entries.pop();
  save();
  return entry;
}

// Resolve any pending entries whose window has elapsed, using getPrice(symbol).
async function resolvePending(getPrice) {
  const now = Date.now();
  const resolved = [];
  let changed = false;
  for (const e of entries) {
    if (e.status === 'pending' && now >= e.resolveTs) {
      try {
        const p = await getPrice(e.symbol);
        if (!Number.isFinite(p)) continue;
        e.exitPrice = p;
        e.win = e.directie === 'UP' ? p > e.entryPrice : p < e.entryPrice;
        e.status = 'resolved';
        changed = true;
        resolved.push(e);
      } catch {
        /* try again next cycle */
      }
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
  const resolved = entries.filter((e) => e.status === 'resolved');
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
  return entries.slice(0, limit);
}

function reset() {
  entries = [];
  save();
}

module.exports = { record, resolvePending, stats, recent, recentByInterval, reset, all: () => entries };
