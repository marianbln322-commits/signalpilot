'use strict';

const fs = require('fs');
const path = require('path');
const { contractBoundaries, boundaryState } = require('./contract-timing');
const { buildCalibration } = require('./calibration');

const LEARNING_MINIMUM_SAMPLE = 30;

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
    n: evaluated.length,
    wins,
    losses: evaluated.length - wins,
    winRate: evaluated.length ? Number((wins / evaluated.length * 100).toFixed(1)) : null,
    wilson95: wilson95(wins, evaluated.length),
  };
}

function setupKey(entry) {
  const trigger = entry && entry.trigger;
  return `${Number(entry && entry.horizonMin)}m|${entry && entry.direction}|${trigger && trigger.timeframe || 'none'}|${trigger && trigger.type || 'none'}`;
}

function compactAnalyses(signal) {
  return Object.fromEntries(Object.entries(signal.timeframeAnalyses || {}).map(([timeframe, item]) => [timeframe, {
    timeframe,
    trend: item.trend,
    momentum: item.momentum,
    structure: item.structure,
    volume: item.volume,
    regime: item.regime,
    rsi: item.rsi,
    atrPct: item.atrPct,
    volumeRatio: item.volumeRatio,
    rangePosition: item.rangePosition,
    distanceFromEma20Atr: item.distanceFromEma20Atr,
    trendStrengthPct: item.trendStrengthPct,
  }]));
}

function outcomeReview(entry, candles) {
  const window = (candles || []).filter((candle) => candle.openTime >= entry.entryOpenTime && candle.closeTime <= entry.targetCloseTime);
  const expectedCandles = Number(entry.horizonMin);
  const continuous = window.length === expectedCandles
    && window[0] && window[0].openTime === entry.entryOpenTime
    && window[window.length - 1].closeTime === entry.targetCloseTime
    && window.every((candle, index) => candle.openTime === entry.entryOpenTime + index * 60_000
      && candle.closeTime === candle.openTime + 60_000 - 1);
  if (!continuous) {
    return {
      reviewedAt: Date.now(), method: 'deterministic-v1', complete: false,
      candlesObserved: window.length, expectedCandles,
      signedMovePct: null, maximumFavorableExcursionPct: null, maximumAdverseExcursionPct: null,
      tags: ['REVIEW_WINDOW_INCOMPLETE'],
      summary: `Review incomplet: ${window.length}/${expectedCandles} lumânări 1m continue; MFE/MAE nu sunt calculate.`,
      ai: null,
    };
  }
  const high = Math.max(...window.map((candle) => candle.high));
  const low = Math.min(...window.map((candle) => candle.low));
  const entryPrice = Number(entry.entryPrice);
  const exitPrice = Number(entry.exitPrice);
  const directionSign = entry.direction === 'UP' ? 1 : -1;
  const signedMovePct = Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(exitPrice)
    ? Number((((exitPrice - entryPrice) / entryPrice) * 100 * directionSign).toFixed(4)) : null;
  const favorablePct = Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(high) && Number.isFinite(low)
    ? Number(((entry.direction === 'UP' ? high - entryPrice : entryPrice - low) / entryPrice * 100).toFixed(4)) : null;
  const adversePct = Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(high) && Number.isFinite(low)
    ? Number(((entry.direction === 'UP' ? entryPrice - low : high - entryPrice) / entryPrice * 100).toFixed(4)) : null;
  const tags = [];
  if (!entry.win) {
    if (entry.trigger && ['BREAKOUT', 'BREAKOUT_RETEST'].includes(entry.trigger.type)) tags.push('BREAKOUT_NECONFIRMAT');
    if (!entry.features || !(entry.features.confirmations || []).includes('volume')) tags.push('FARA_CONFIRMARE_VOLUM');
    if (Number(entry.quality) < 75) tags.push('CONFLUENTA_LA_LIMITA');
    if (Number.isFinite(adversePct) && Number.isFinite(favorablePct) && adversePct > Math.max(0.01, favorablePct * 1.5)) tags.push('REVERSARE_RAPIDA');
    const execution = entry.features && entry.features.executionTimeframes || [];
    const overextended = execution.some((timeframe) => {
      const analysis = entry.features.analyses && entry.features.analyses[timeframe];
      if (!analysis) return false;
      const distance = Number(analysis.distanceFromEma20Atr);
      const signedExtension = entry.direction === 'UP' ? distance : -distance;
      return Number.isFinite(signedExtension) && signedExtension > 1.8;
    });
    if (overextended) tags.push('INTRARE_EXTINSA');
    if (!tags.length) tags.push('VARIANTA_ADVERSA_FARA_CAUZA_UNICA');
  }
  return {
    reviewedAt: Date.now(), method: 'deterministic-v1', complete: true,
    candlesObserved: window.length, expectedCandles,
    signedMovePct, maximumFavorableExcursionPct: favorablePct, maximumAdverseExcursionPct: adversePct,
    tags,
    summary: entry.win
      ? `WIN: direcția a închis favorabil cu ${signedMovePct == null ? '—' : signedMovePct}% la expirare.`
      : `LOSS: direcția a închis nefavorabil cu ${signedMovePct == null ? '—' : signedMovePct}%; cauze candidate: ${tags.join(', ')}.`,
    ai: null,
  };
}

function groupedPerformance(entries, keySelector) {
  const groups = new Map();
  for (const entry of entries || []) {
    if (entry.status !== 'resolved') continue;
    const key = keySelector(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return Object.fromEntries([...groups].map(([key, values]) => [key, { key, ...aggregate(values) }]));
}

class Journal {
  constructor(filePath, engineVersion = null) {
    this.filePath = filePath;
    this.engineVersion = engineVersion;
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
      id: signal.signalKey,
      signalKey: signal.signalKey,
      symbol: signal.symbol,
      engineVersion: signal.engineVersion || this.engineVersion,
      horizonMin,
      direction,
      quality: signal.quality,
      trigger: signal.trigger,
      setupFingerprint: signal.setupFingerprint,
      features: {
        protocol: signal.protocol,
        executionTimeframes: signal.executionTimeframes,
        contextTimeframes: signal.contextTimeframes,
        confirmations: signal.confirmations,
        directionScores: signal.directionScores,
        frameBiases: signal.frameBiases,
        qualityComponents: signal.qualityComponents,
        analyses: compactAnalyses(signal),
      },
      signalCloseTime: signal.latestClosedCandleTime,
      generatedAt,
      observedAt: generatedAt,
      entryOpenTime: timing.entryOpenTime,
      entryPrice: null,
      targetCloseTime: timing.expiryCloseTime,
      exitCloseTime: null,
      exitPrice: null,
      status: 'pending',
      invalidReason: null,
      win: null,
      review: null,
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
      const boundaries = { entryOpenTime: entry.entryOpenTime, expiryCloseTime: entry.targetCloseTime };
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
      entry.review = outcomeReview(entry, candles);
      changed = true;
      resolved.push(entry);
    }
    if (changed) this.save();
    return resolved;
  }

  attachAiReview(signalKey, aiReview) {
    const entry = this.entries.find((item) => item.signalKey === signalKey);
    if (!entry || entry.status !== 'resolved' || entry.win !== false || !entry.review) return false;
    entry.review.ai = { ...aiReview, attachedAt: Date.now() };
    this.save();
    return true;
  }

  lossesNeedingAiReview(limit = 3) {
    return this.currentEntries()
      .filter((entry) => entry.status === 'resolved' && entry.win === false
        && entry.review && entry.review.complete !== false && !entry.review.ai)
      .slice(0, Math.max(0, limit));
  }

  currentEntries() {
    return this.engineVersion
      ? this.entries.filter((entry) => entry.engineVersion === this.engineVersion)
      : this.entries;
  }

  calibration() {
    const current = this.currentEntries();
    const resolved = current.filter((entry) => entry.status === 'resolved');
    const symbols = [...new Set(resolved.map((entry) => entry.symbol))];
    return {
      source: 'forward',
      minimumSample: LEARNING_MINIMUM_SAMPLE,
      all: buildCalibration(resolved),
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, buildCalibration(resolved.filter((entry) => entry.symbol === symbol))])),
    };
  }

  learningReport(payoutByHorizon = {}) {
    const resolved = this.currentEntries().filter((entry) => entry.status === 'resolved');
    const setupPerformance = groupedPerformance(resolved, setupKey);
    const tagCounts = {};
    for (const entry of resolved.filter((item) => item.win === false)) {
      for (const tag of entry.review && entry.review.tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    const breakEven = Object.fromEntries([10, 30].map((horizon) => {
      const payout = Number(payoutByHorizon[horizon]);
      return [`${horizon}m`, Number.isFinite(payout) && payout > 0 ? Number((100 / (1 + payout)).toFixed(2)) : null];
    }));
    return {
      policy: 'fail-closed only: learning may block a statistically unreliable ENTER, never create or flip a signal',
      minimumSample: LEARNING_MINIMUM_SAMPLE,
      breakEvenWinRate: breakEven,
      bySetup: setupPerformance,
      lossTagCounts: tagCounts,
      reviewedLosses: resolved.filter((entry) => entry.win === false && entry.review).length,
      aiReviewedLosses: resolved.filter((entry) => entry.win === false && entry.review && entry.review.ai).length,
    };
  }

  applyLearningGuard(signal, payout) {
    if (!signal || signal.action !== 'ENTER' || !signal.trigger) return signal;
    const comparable = this.currentEntries().filter((entry) => entry.status === 'resolved'
      && entry.symbol === signal.symbol
      && entry.horizonMin === signal.horizonMin
      && entry.direction === signal.direction
      && entry.trigger && entry.trigger.type === signal.trigger.type
      && entry.trigger.timeframe === signal.trigger.timeframe);
    const performance = aggregate(comparable);
    const breakEvenWinRate = Number.isFinite(Number(payout)) && Number(payout) > 0 ? 100 / (1 + Number(payout)) : null;
    const enough = performance.n >= LEARNING_MINIMUM_SAMPLE;
    const blocked = enough && Number.isFinite(breakEvenWinRate)
      && Number.isFinite(performance.wilson95.high) && performance.wilson95.high < breakEvenWinRate;
    const learningGuard = {
      key: setupKey(signal),
      sample: performance.n,
      minimumSample: LEARNING_MINIMUM_SAMPLE,
      winRate: performance.winRate,
      wilson95: performance.wilson95,
      breakEvenWinRate: Number.isFinite(breakEvenWinRate) ? Number(breakEvenWinRate.toFixed(2)) : null,
      blocked,
      rule: 'blochează numai dacă N>=30 și limita superioară Wilson95 este sub break-even; nu poate crea sau inversa semnale',
    };
    if (!blocked) return { ...signal, learningGuard };
    return {
      ...signal,
      intendedDirection: signal.direction,
      action: 'WAIT',
      direction: null,
      verdict: 'WAIT',
      signalKey: null,
      learningGuard,
      reasonCodes: [...new Set([...(signal.reasonCodes || []), 'LEARNED_SETUP_UNRELIABLE'])],
      gateChecks: [...(signal.gateChecks || []), {
        code: 'LEARNED_SETUP_UNRELIABLE',
        pass: false,
        detail: `N=${performance.n}, Wilson95 high=${performance.wilson95.high}% < break-even=${learningGuard.breakEvenWinRate}%`,
      }],
      conflicts: [...(signal.conflicts || []), 'profilul forward comparabil este statistic sub break-even; intrarea a fost blocată'],
    };
  }

  stats() {
    const current = this.currentEntries();
    const resolved = current.filter((entry) => entry.status === 'resolved');
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
      issuedByDirection: {
        UP: current.filter((entry) => entry.direction === 'UP').length,
        DOWN: current.filter((entry) => entry.direction === 'DOWN').length,
      },
      pending: current.filter((entry) => entry.status === 'pending').length,
      invalid: current.filter((entry) => entry.status === 'invalid').length,
      total: current.length,
      excludedOtherEngineVersions: this.entries.length - current.length,
    };
  }

  snapshot(limit = 100, payoutByHorizon = {}) {
    return {
      engineVersion: this.engineVersion,
      stats: this.stats(),
      calibration: this.calibration(),
      learning: this.learningReport(payoutByHorizon),
      recent: this.currentEntries().slice(0, limit),
    };
  }
}

module.exports = {
  Journal, atomicWriteJson, aggregate, wilson95,
  setupKey, outcomeReview, LEARNING_MINIMUM_SAMPLE,
};
