'use strict';

const fs = require('fs');
const path = require('path');
const { contractBoundaries, boundaryState } = require('./contract-timing');
const { buildCalibration } = require('./calibration');

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[journal] read failed: ${error.message}`);
    return fallback;
  }
}

function wilson95(wins, n) {
  if (!n) return { low: null, high: null };
  const z = 1.959963984540054;
  const p = wins / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n) / denominator;
  return {
    low: Number((Math.max(0, center - margin) * 100).toFixed(1)),
    high: Number((Math.min(1, center + margin) * 100).toFixed(1)),
  };
}

function aggregate(entries) {
  const evaluated = (entries || []).filter((entry) => entry.status === 'resolved');
  const wins = evaluated.filter((entry) => entry.win).length;
  return {
    n: evaluated.length, wins,
    winRate: evaluated.length ? Number((wins / evaluated.length * 100).toFixed(1)) : null,
    wilson95: wilson95(wins, evaluated.length),
  };
}

class Journal {
  constructor(filePath) {
    this.filePath = filePath;
    const loaded = loadJson(filePath, []);
    this.entries = Array.isArray(loaded) ? loaded : [];
    let migrated = false;
    for (const entry of this.entries) {
      if (entry.status === 'pending' && (!Number.isFinite(entry.entryOpenTime) || !Number.isFinite(entry.targetCloseTime))) {
        entry.status = 'invalid';
        entry.invalidReason = 'LEGACY_TIMING_BOUNDARY_UNDEFINED';
        entry.win = null;
        migrated = true;
      }
    }
    if (migrated) this.save();
  }

  save() {
    atomicWriteJson(this.filePath, this.entries);
  }

  record(signal) {
    const direction = signal && (signal.direction || signal.verdict);
    if (!signal || signal.action === 'WAIT' || !signal.signalKey || !['UP', 'DOWN'].includes(direction)) return null;
    if (this.entries.some((entry) => entry.signalKey === signal.signalKey)) return null;
    const horizonMin = Number(signal.horizonMin);
    const generatedAt = Number(signal.generatedAt);
    const timing = contractBoundaries(generatedAt, horizonMin);
    const entry = {
      id: signal.signalKey, signalKey: signal.signalKey, symbol: signal.symbol,
      horizonMin, direction, quality: signal.quality, trigger: signal.trigger,
      signalCloseTime: signal.latestClosedCandleTime, generatedAt, observedAt: generatedAt,
      entryOpenTime: timing.entryOpenTime, entryPrice: null,
      targetCloseTime: timing.expiryCloseTime, exitCloseTime: null, exitPrice: null,
      status: 'pending', invalidReason: null, win: null,
    };
    this.entries.unshift(entry);
    if (this.entries.length > 5_000) this.entries.length = 5_000;
    this.save();
    return entry;
  }

  resolveFromClosedCandles(candlesBySymbol) {
    const resolved = [];
    let changed = false;
    for (const entry of this.entries) {
      if (entry.status !== 'pending') continue;
      const candles = candlesBySymbol[entry.symbol] || [];
      if (!candles.length) continue;
      const boundaries = {
        entryOpenTime: entry.entryOpenTime,
        expiryCloseTime: entry.targetCloseTime,
      };
      const boundary = boundaryState(candles, boundaries);
      if (boundary.status === 'invalid') {
        entry.status = 'invalid';
        entry.invalidReason = boundary.reason;
        entry.win = null;
        changed = true;
        continue;
      }
      if (boundary.entry && entry.entryPrice == null) {
        entry.entryPrice = boundary.entry.open;
        changed = true;
      }
      if (boundary.status !== 'complete') continue;
      entry.exitCloseTime = boundary.exit.closeTime;
      entry.exitPrice = boundary.exit.close;
      entry.win = entry.direction === 'UP' ? entry.exitPrice > entry.entryPrice : entry.exitPrice < entry.entryPrice;
      entry.status = 'resolved';
      changed = true;
      resolved.push(entry);
    }
    if (changed) this.save();
    return resolved;
  }

  calibration() {
    const resolved = this.entries.filter((entry) => entry.status === 'resolved');
    const symbols = [...new Set(resolved.map((entry) => entry.symbol))];
    return {
      source: 'forward', minimumSample: 30,
      all: buildCalibration(resolved),
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, buildCalibration(resolved.filter((entry) => entry.symbol === symbol))])),
    };
  }

  stats() {
    const resolved = this.entries.filter((entry) => entry.status === 'resolved');
    return {
      overall: aggregate(resolved),
      byHorizon: {
        '10m': aggregate(resolved.filter((entry) => entry.horizonMin === 10)),
        '30m': aggregate(resolved.filter((entry) => entry.horizonMin === 30)),
      },
      byDirection: {
        UP: aggregate(resolved.filter((entry) => entry.direction === 'UP')),
        DOWN: aggregate(resolved.filter((entry) => entry.direction === 'DOWN')),
      },
      pending: this.entries.filter((entry) => entry.status === 'pending').length,
      invalid: this.entries.filter((entry) => entry.status === 'invalid').length,
      total: this.entries.length,
    };
  }

  snapshot(limit = 100) {
    return { stats: this.stats(), calibration: this.calibration(), recent: this.entries.slice(0, limit) };
  }
}

module.exports = { Journal, atomicWriteJson, aggregate, wilson95 };
