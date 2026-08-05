'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./expert-engine');
const market = require('./mexc-market-data');
const { INTERVAL_MS } = market;
const { atomicWriteJson, wilson95 } = require('./journal');
const { contractBoundaries } = require('./contract-timing');
const { buildCalibration } = require('./calibration');

const BINANCE_VISION_API = 'https://data-api.binance.vision';
const SOURCE = 'Binance Vision spot data — proxy, nu istoric MEXC exact';
const MINUTE_MS = 60_000;

async function fetchPage(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error('unexpected non-array response');
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Binance Vision timeout after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeStrict(row, symbol = 'unknown') {
  if (!Array.isArray(row) || row.length < 7) throw new Error(`${symbol}: malformed 1m row`);
  const candle = {
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]),
    quoteVolume: row[7] == null ? 0 : Number(row[7]),
  };
  const finite = Object.values(candle).every(Number.isFinite);
  const validOhlc = candle.openTime >= 0
    && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0
    && candle.volume >= 0 && candle.quoteVolume >= 0
    && candle.high >= Math.max(candle.open, candle.close, candle.low)
    && candle.low <= Math.min(candle.open, candle.close, candle.high);
  const validTiming = candle.openTime % MINUTE_MS === 0 && candle.closeTime === candle.openTime + MINUTE_MS - 1;
  if (!finite || !validOhlc || !validTiming) throw new Error(`${symbol}: invalid strict 1m OHLC/timing at ${row[0]}`);
  return candle;
}

function validateContinuity(candles) {
  const invalidIntervals = [];
  for (let index = 1; index < candles.length; index += 1) {
    const expected = candles[index - 1].openTime + MINUTE_MS;
    if (candles[index].openTime !== expected) {
      invalidIntervals.push({
        afterOpenTime: candles[index - 1].openTime,
        beforeOpenTime: candles[index].openTime,
        expectedOpenTime: expected,
        reason: candles[index].openTime > expected ? 'MISSING_1M_CANDLES' : 'NON_MONOTONIC_OR_OVERLAP',
      });
    }
  }
  return invalidIntervals;
}

function alignedCoverage(days, endTime) {
  const coverageEndCloseTime = Math.floor(endTime / MINUTE_MS) * MINUTE_MS - 1;
  const coverageStartOpenTime = coverageEndCloseTime + 1 - days * 86_400_000;
  return { coverageStartOpenTime, coverageEndCloseTime };
}

async function fetchHistory(symbol, days, { cacheDir, endTime = Date.now() } = {}) {
  const coverage = alignedCoverage(days, endTime);
  const cachePath = path.join(cacheDir, `${symbol}-1m-${coverage.coverageStartOpenTime}-${coverage.coverageEndCloseTime}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached && cached.coverageStartOpenTime === coverage.coverageStartOpenTime
      && cached.coverageEndCloseTime === coverage.coverageEndCloseTime && Array.isArray(cached.candles)) {
      const candles = cached.candles.map((candle) => normalizeStrict([
        candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.closeTime, candle.quoteVolume,
      ], symbol));
      if (candles[0] && candles[0].openTime === coverage.coverageStartOpenTime
        && candles[candles.length - 1].closeTime === coverage.coverageEndCloseTime) {
        return { candles, coverage, invalidIntervals: validateContinuity(candles), cacheHit: true };
      }
    }
  } catch { /* exact-coverage cache miss */ }

  let cursor = coverage.coverageStartOpenTime;
  const all = [];
  for (let request = 0; cursor <= coverage.coverageEndCloseTime && request < 70; request += 1) {
    const url = `${BINANCE_VISION_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=1000&startTime=${cursor}&endTime=${coverage.coverageEndCloseTime}`;
    const rows = await fetchPage(url);
    if (!rows.length) break;
    for (const row of rows) all.push(normalizeStrict(row, symbol));
    const next = Number(rows[rows.length - 1][0]) + MINUTE_MS;
    if (next <= cursor) throw new Error('Binance Vision pagination made no progress');
    cursor = next;
    if (rows.length < 1000) break;
  }
  const deduped = new Map();
  for (const candle of all) {
    if (candle.openTime >= coverage.coverageStartOpenTime && candle.closeTime <= coverage.coverageEndCloseTime) deduped.set(candle.openTime, candle);
  }
  const candles = [...deduped.values()].sort((a, b) => a.openTime - b.openTime);
  if (!candles.length || candles[0].openTime !== coverage.coverageStartOpenTime
    || candles[candles.length - 1].closeTime !== coverage.coverageEndCloseTime) {
    throw new Error(`Binance Vision coverage incomplete: requested ${coverage.coverageStartOpenTime}-${coverage.coverageEndCloseTime}, received ${candles[0] ? candles[0].openTime : 'none'}-${candles.length ? candles[candles.length - 1].closeTime : 'none'}`);
  }
  const invalidIntervals = validateContinuity(candles);
  atomicWriteJson(cachePath, { ...coverage, candles });
  return { candles, coverage, invalidIntervals, cacheHit: false };
}

function aggregateTimeframe(candles, timeframe, integrity = null) {
  const duration = INTERVAL_MS[timeframe];
  if (duration === MINUTE_MS) {
    if (integrity) Object.assign(integrity, {
      timeframe, expectedMinutesPerBucket: 1, completeBuckets: candles.length,
      incompleteBucketsSkipped: 0, incompleteExamples: [],
    });
    return candles.slice();
  }
  const expected = duration / MINUTE_MS;
  const buckets = new Map();
  for (const candle of candles) {
    const bucketOpen = Math.floor(candle.openTime / duration) * duration;
    if (!buckets.has(bucketOpen)) buckets.set(bucketOpen, []);
    buckets.get(bucketOpen).push(candle);
  }
  const output = [];
  let incompleteBucketsSkipped = 0;
  const incompleteExamples = [];
  for (const [openTime, rows] of buckets) {
    rows.sort((a, b) => a.openTime - b.openTime);
    const complete = rows.length === expected && rows.every((row, index) => row.openTime === openTime + index * MINUTE_MS
      && row.closeTime === row.openTime + MINUTE_MS - 1);
    if (!complete) {
      incompleteBucketsSkipped += 1;
      if (incompleteExamples.length < 20) incompleteExamples.push({ openTime, expectedMinutes: expected, actualMinutes: rows.length });
      continue;
    }
    output.push({
      openTime, open: rows[0].open, high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)), close: rows[rows.length - 1].close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
      closeTime: rows[rows.length - 1].closeTime,
      quoteVolume: rows.reduce((sum, row) => sum + (row.quoteVolume || 0), 0),
    });
  }
  if (integrity) Object.assign(integrity, {
    timeframe, expectedMinutesPerBucket: expected, completeBuckets: output.length,
    incompleteBucketsSkipped, incompleteExamples,
  });
  return output.sort((a, b) => a.openTime - b.openTime);
}

function metadataAt(candles, timeframe, asOf) {
  return { ...market.buildMetadata(candles, { timeframe, asOf, settleDelayMs: 0 }), source: SOURCE };
}

function upperBoundCloseTime(candles, asOf) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= asOf) low = middle + 1;
    else high = middle;
  }
  return low;
}

function summarize(records, payout) {
  const n = records.length;
  const wins = records.filter((record) => record.win).length;
  const rate = n ? wins / n : null;
  const hasPayout = Number.isFinite(payout);
  return {
    n, wins, winRate: n ? Number((rate * 100).toFixed(1)) : null,
    wilson95: wilson95(wins, n), payout: hasPayout ? payout : null,
    breakEvenWinRate: hasPayout ? Number((100 / (1 + payout)).toFixed(1)) : null,
    evPerUnit: rate == null || !hasPayout ? null : Number((rate * payout - (1 - rate)).toFixed(4)),
  };
}

async function run({ symbol, days = 7, minQuality10 = 65, minQuality30 = 68, payout10 = 0.8, payout30 = 0.8, cacheDir, onProgress = () => {} }) {
  const safeDays = Math.min(30, Math.max(1, Math.floor(Number(days) || 7)));
  const endTime = Date.now();
  const evaluationCoverage = alignedCoverage(safeDays, endTime);
  const preRollDays = 13;
  onProgress({ phase: 'download', percent: 0 });
  const history = await fetchHistory(symbol, safeDays + preRollDays, { cacheDir, endTime });
  const oneMinute = history.candles;
  const aggregateIntegrity = {};
  const series = Object.fromEntries(Object.keys(INTERVAL_MS).map((timeframe) => {
    aggregateIntegrity[timeframe] = {};
    return [timeframe, aggregateTimeframe(oneMinute, timeframe, aggregateIntegrity[timeframe])];
  }));
  const byOpen = new Map(oneMinute.map((candle) => [candle.openTime, candle]));
  const byClose = new Map(oneMinute.map((candle) => [candle.closeTime, candle]));
  const results = [];
  const seenSignalKeys = new Set();
  const counters = {
    opportunities: { '10m': 0, '30m': 0 }, signals: { '10m': 0, '30m': 0 }, waits: { '10m': 0, '30m': 0 },
    skippedInvalidSnapshots: 0, skippedMissingBoundaries: 0,
  };
  const warmup = 4_000;
  const evaluationStartIndex = oneMinute.findIndex((candle) => candle.openTime >= evaluationCoverage.coverageStartOpenTime);
  const firstEvaluationIndex = Math.max(warmup, evaluationStartIndex < 0 ? warmup : evaluationStartIndex);
  const finalEvaluationIndex = oneMinute.length - 31;
  for (let index = firstEvaluationIndex; index < finalEvaluationIndex; index += 1) {
    const asOf = oneMinute[index].closeTime;
    const candles = {};
    const metadata = {};
    let ready = true;
    for (const timeframe of Object.keys(INTERVAL_MS)) {
      const endIndex = upperBoundCloseTime(series[timeframe], asOf);
      const visible = series[timeframe].slice(Math.max(0, endIndex - market.ANALYSIS_CANDLE_COUNT), endIndex);
      if (visible.length !== market.ANALYSIS_CANDLE_COUNT) { ready = false; break; }
      candles[timeframe] = visible;
      metadata[timeframe] = metadataAt(visible, timeframe, asOf);
      // Backtest indicators consume the entire visible window, so any gap in that
      // window invalidates the opportunity even if it is older than the live recent-gap gate.
      if (!metadata[timeframe].valid || metadata[timeframe].gaps > 0) ready = false;
    }
    if (!ready) {
      counters.skippedInvalidSnapshots += 1;
      continue;
    }
    const analysis = engine.analyzeSnapshot({ symbol, asOf, generatedAt: asOf, settleDelayMs: 0, source: SOURCE, candles, metadata }, { minQuality10, minQuality30 });
    for (const horizonKey of ['10m', '30m']) {
      counters.opportunities[horizonKey] += 1;
      const prediction = analysis.predictions[horizonKey];
      if (prediction.action === 'WAIT') { counters.waits[horizonKey] += 1; continue; }
      if (seenSignalKeys.has(prediction.signalKey)) continue;
      seenSignalKeys.add(prediction.signalKey);
      counters.signals[horizonKey] += 1;
      const timing = contractBoundaries(prediction.generatedAt, prediction.horizonMin);
      const entry = byOpen.get(timing.entryOpenTime);
      const exit = byClose.get(timing.expiryCloseTime);
      if (!entry || !exit) { counters.skippedMissingBoundaries += 1; continue; }
      if (entry.openTime <= prediction.generatedAt || exit.closeTime !== timing.expiryCloseTime) throw new Error('backtest timing invariant failed');
      const win = prediction.direction === 'UP' ? exit.close > entry.open : exit.close < entry.open;
      results.push({
        signalKey: prediction.signalKey, horizonMin: prediction.horizonMin, direction: prediction.direction, quality: prediction.quality,
        generatedAt: prediction.generatedAt, signalCloseTime: prediction.latestClosedCandleTime,
        entryOpenTime: entry.openTime, entryPrice: entry.open,
        exitCloseTime: exit.closeTime, exitPrice: exit.close, win,
      });
    }
    if ((index - firstEvaluationIndex) % 500 === 0) {
      const denominator = Math.max(1, finalEvaluationIndex - firstEvaluationIndex);
      onProgress({ phase: 'replay', percent: Math.min(99, Math.round((index - firstEvaluationIndex) / denominator * 100)), index, total: denominator });
    }
  }
  const byHorizon = {
    '10m': summarize(results.filter((item) => item.horizonMin === 10), payout10),
    '30m': summarize(results.filter((item) => item.horizonMin === 30), payout30),
  };
  const result = {
    symbol, days: safeDays, source: SOURCE,
    proxyDisclosure: 'Datele sunt Binance Vision proxy/in-sample și pot diferi de MEXC; rezultatul istoric nu prezice sigur semnalul curent.',
    methodology: 'Replay event-time cu closeTime<=T; intrare numai la primul 1m open strict după generatedAt; expirare la closeTime exact al minutei finale. Boundary lipsă = invalid, fără substituție.',
    fixedParameters: { minQuality10, minQuality30, payout10, payout30, adaptiveTuning: false },
    totalOneMinuteCandles: oneMinute.length,
    coverage: history.coverage,
    evaluationWindow: {
      requestedDays: safeDays, startsAt: evaluationCoverage.coverageStartOpenTime,
      endsAt: evaluationCoverage.coverageEndCloseTime, preRollDays,
      opportunitiesStartAt: oneMinute[firstEvaluationIndex] ? oneMinute[firstEvaluationIndex].closeTime : null,
    },
    integrity: {
      strictOhlc: true, strictOneMinuteContinuity: history.invalidIntervals.length === 0,
      invalidIntervals: history.invalidIntervals, skippedInvalidSnapshots: counters.skippedInvalidSnapshots,
      skippedMissingBoundaries: counters.skippedMissingBoundaries, aggregateBucketsRequireCompleteMinutes: true,
      aggregateTimeframes: aggregateIntegrity,
    },
    opportunities: counters.opportunities, signals: counters.signals,
    waitCoverage: {
      '10m': counters.opportunities['10m'] ? Number((counters.waits['10m'] / counters.opportunities['10m'] * 100).toFixed(1)) : null,
      '30m': counters.opportunities['30m'] ? Number((counters.waits['30m'] / counters.opportunities['30m'] * 100).toFixed(1)) : null,
    },
    evaluated: results.length, overall: summarize(results, null), byHorizon,
    byDirection: {
      UP: summarize(results.filter((item) => item.direction === 'UP'), null),
      DOWN: summarize(results.filter((item) => item.direction === 'DOWN'), null),
    },
    calibration: { source: 'backtest-proxy-in-sample', minimumSample: 50, ...buildCalibration(results) },
  };
  onProgress({ phase: 'complete', percent: 100, evaluated: results.length });
  return result;
}

module.exports = {
  run, fetchHistory, aggregateTimeframe, metadataAt, summarize, normalizeStrict,
  validateContinuity, alignedCoverage, SOURCE,
};
