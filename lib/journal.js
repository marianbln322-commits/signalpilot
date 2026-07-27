'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'journal.json');
let entries = load();

function canonicalEventId(value) {
  const legacyObs = String(value.id || '').match(/^obs-([A-Z0-9]+)-(\d+)$/);
  const decisionTs = value.decisionCandleTs ?? value.candleOpen ?? (legacyObs ? Number(legacyObs[2]) : value.entryTs ?? value.ts);
  const bucket = Math.floor((Number(decisionTs) || 0) / (5 * 60 * 1000));
  const policyVersion = value.policyVersion || 'legacy';
  return `${policyVersion}-${value.symbol || legacyObs?.[1] || 'UNKNOWN'}-${bucket}-${value.directie || 'NEUTRU'}`;
}

function migrate(raw) {
  const byId = new Map();
  for (const original of Array.isArray(raw) ? raw : []) {
    const e = { ...original };
    e.alerted = e.alerted ?? !e.observation;
    e.observation = !e.alerted;
    if (e.status === 'settlement_error') {
      e.status = 'pending';
      e.nextSettlementAttemptTs = null;
    }
    e.eventId = canonicalEventId(e);
    e.id = e.eventId;
    const previous = byId.get(e.eventId);
    if (!previous) {
      byId.set(e.eventId, e);
      continue;
    }
    // Merge legacy observation+alert duplicates, preferring the executed alert
    // while retaining richer context from either record.
    const primary = e.alerted && !previous.alerted ? e : previous;
    const secondary = primary === e ? previous : e;
    byId.set(e.eventId, { ...secondary, ...primary, alerted: primary.alerted || secondary.alerted, observation: !(primary.alerted || secondary.alerted) });
  }
  return [...byId.values()].sort((a, b) => (b.entryTs || 0) - (a.entryTs || 0));
}

function load() {
  try {
    if (fs.existsSync(FILE)) return migrate(JSON.parse(fs.readFileSync(FILE, 'utf8')));
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

function eventId(sig) {
  return canonicalEventId(sig);
}

// One market decision is one statistical event. If it later becomes an alert,
// update the observation instead of inserting the same outcome a second time.
function record(sig) {
  const horizonMin = sig.interval === '10 minute' ? 10 : 30;
  const id = eventId(sig);
  const isObservation = !!sig.observation;
  const existing = entries.find((e) => e.id === id || e.eventId === id);
  if (existing) {
    const wasAlerted = !!existing.alerted;
    if (!isObservation && !wasAlerted) {
      existing.signalReferencePrice = Number(sig.signalReferencePrice ?? existing.entryPrice);
      existing.signalResolveTs = Number(sig.signalExpiryTs ?? existing.resolveTs);
      existing.entryPrice = Number(sig.price);
      existing.entryTs = Number(sig.ts) || Date.now();
      existing.resolveTs = Number(sig.expiryTs) || existing.entryTs + horizonMin * 60 * 1000;
      existing.alerted = true;
      existing.observation = false;
      existing.interval = sig.interval || existing.interval;
      existing.incredere = sig.incredere || existing.incredere;
      existing.setup = sig.setup || existing.setup;
      existing.hourUTC = sig.hourUTC ?? existing.hourUTC;
      existing.ofState = sig.ofState ?? existing.ofState;
      existing.ofAgree = sig.ofAgree ?? existing.ofAgree;
      existing.orderflow = sig.orderflow ?? existing.orderflow;
      existing.derivatives = sig.derivatives ?? existing.derivatives;
      existing.sniper = !!sig.sniper;
      existing.payout = sig.payout ?? existing.payout ?? null;
      existing.policyVersion = sig.policyVersion || existing.policyVersion;
      existing.updatedTs = Date.now();
      save();
    }
    return { entry: existing, created: false, promoted: !isObservation && !wasAlerted, alreadyAlerted: !isObservation && wasAlerted };
  }

  const entryTs = Number(sig.ts) || Date.now();
  const entry = {
    id,
    eventId: id,
    observation: isObservation,
    alerted: !isObservation,
    symbol: sig.symbol,
    directie: sig.directie,
    interval: sig.interval,
    incredere: sig.incredere,
    sniper: !!sig.sniper,
    setup: sig.setup || null,
    hourUTC: sig.hourUTC != null ? sig.hourUTC : new Date(entryTs).getUTCHours(),
    ofState: sig.ofState || null,
    ofAgree: sig.ofAgree || null,
    orderflow: sig.orderflow || null,
    derivatives: sig.derivatives || null,
    payout: sig.payout ?? null,
    policyVersion: sig.policyVersion || 'legacy',
    decisionCandleTs: sig.decisionCandleTs ?? null,
    signalReferencePrice: Number(sig.signalReferencePrice ?? sig.price),
    signalResolveTs: Number(sig.signalExpiryTs ?? sig.expiryTs) || entryTs + horizonMin * 60 * 1000,
    entryPrice: Number(sig.price),
    entryTs,
    resolveTs: Number(sig.expiryTs) || entryTs + horizonMin * 60 * 1000,
    settlementSource: sig.settlementSource || 'MEXC spot 1m close proxy',
    status: 'pending',
    settlementAttempts: 0,
    exitPrice: null,
    exitTs: null,
    win: null,
  };
  entries.unshift(entry);
  if (entries.length > 8000) {
    const idx = entries.map((e, i) => [e, i]).reverse().find(([e]) => !e.alerted);
    if (idx) entries.splice(idx[1], 1);
    else entries.pop();
  }
  save();
  return { entry, created: true, promoted: false, alreadyAlerted: false };
}

async function resolvePending(getSettlement) {
  const now = Date.now();
  const resolved = [];
  let changed = false;
  for (const e of entries) {
    if (e.status !== 'pending' || now < e.resolveTs || now < Number(e.nextSettlementAttemptTs || 0)) continue;
    try {
      const result = await getSettlement(e);
      const price = typeof result === 'number' ? result : Number(result?.price);
      if (!Number.isFinite(price)) continue;
      e.exitPrice = price;
      e.exitTs = Number(result?.candle?.closeTime ?? result?.ts ?? e.resolveTs);
      e.settlementSource = result?.source || e.settlementSource;
      if (price === e.entryPrice) {
        e.status = 'void';
        e.win = null;
      } else {
        e.win = e.directie === 'UP' ? price > e.entryPrice : price < e.entryPrice;
        e.status = 'resolved';
      }
      e.settlementAttempts = Number(e.settlementAttempts || 0);
      e.lastSettlementError = null;
      e.nextSettlementAttemptTs = null;
      changed = true;
      resolved.push(e);
    } catch (error) {
      e.settlementAttempts = Number(e.settlementAttempts || 0) + 1;
      e.lastSettlementError = error?.message || 'settlement unavailable';
      const backoffMs = Math.min(60 * 60 * 1000, 10 * 1000 * (2 ** Math.min(e.settlementAttempts, 8)));
      e.nextSettlementAttemptTs = now + backoffMs;
      changed = true;
    }
  }
  if (changed) save();
  return resolved;
}

function agg(arr) {
  const valid = arr.filter((e) => e.status === 'resolved' && typeof e.win === 'boolean');
  const n = valid.length;
  const wins = valid.filter((e) => e.win).length;
  return { n, wins, winRate: n ? +((wins / n) * 100).toFixed(1) : null };
}

function recentByInterval(limit = 20, alertedOnly = true, policyVersion = null) {
  const resolved = entries.filter((e) =>
    e.status === 'resolved' &&
    (!alertedOnly || e.alerted || !e.observation) &&
    (!policyVersion || e.policyVersion === policyVersion)
  );
  const independent = (interval) => {
    const selected = [];
    const nextStartBySymbol = new Map();
    for (const e of resolved.filter((row) => row.interval === interval)) {
      const nextStart = nextStartBySymbol.get(e.symbol) ?? Infinity;
      if ((e.resolveTs || 0) > nextStart) continue;
      selected.push(e);
      nextStartBySymbol.set(e.symbol, e.entryTs || 0);
      if (selected.length >= limit) break;
    }
    return selected;
  };
  return { tenMin: agg(independent('10 minute')), thirtyMin: agg(independent('30 minute')) };
}

function stats() {
  const resolved = entries.filter((e) => e.status === 'resolved' && (e.alerted || !e.observation));
  const symbols = [...new Set(resolved.map((e) => e.symbol))];
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
    recentInterval: recentByInterval(20, true),
    pending: entries.filter((e) => e.status === 'pending').length,
    settlementDelayed: entries.filter((e) => e.status === 'pending' && Number(e.settlementAttempts || 0) > 0).length,
    void: entries.filter((e) => e.status === 'void').length,
    total: entries.length,
  };
}

function recent(limit = 40) {
  return entries.filter((e) => e.alerted || !e.observation).slice(0, limit);
}

function reset() {
  entries = [];
  save();
}

module.exports = {
  record, resolvePending, stats, recent, recentByInterval, reset, all: () => entries,
  eventId, canonicalEventId, migrate,
};
