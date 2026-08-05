'use strict';

const { contractBoundaries } = require('./contract-timing');

const ANALYSIS_CANDLE_COUNT = 300;

const HORIZONS = Object.freeze({
  10: { minutes: 10, execution: ['1m', '5m'], context: ['15m'], triggerFrames: ['1m', '5m'], triggerMaxAgeMs: 10 * 60_000 },
  30: { minutes: 30, execution: ['5m', '15m', '30m'], context: ['60m'], triggerFrames: ['5m', '15m', '30m'], triggerMaxAgeMs: 30 * 60_000 },
});

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const last = (values) => values[values.length - 1];
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function ema(values, period) {
  if (values.length < period) return null;
  const output = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  output[period - 1] = seed / period;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) output[i] = values[i] * multiplier + output[i - 1] * (1 - multiplier);
  return output;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  const output = new Array(values.length).fill(null);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    gains += Math.max(0, delta);
    losses += Math.max(0, -delta);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  output[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, delta)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -delta)) / period;
    output[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return output;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const tr = candles.map((candle, index) => index === 0 ? candle.high - candle.low : Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index - 1].close),
    Math.abs(candle.low - candles[index - 1].close),
  ));
  const output = new Array(candles.length).fill(null);
  output[period] = average(tr.slice(1, period + 1));
  for (let i = period + 1; i < candles.length; i += 1) output[i] = (output[i - 1] * (period - 1) + tr[i]) / period;
  return output;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  if (!fast || !slow) return null;
  const line = values.map((_, index) => fast[index] == null || slow[index] == null ? null : fast[index] - slow[index]);
  const compact = line.filter(Number.isFinite);
  const signalCompact = ema(compact, 9);
  if (!signalCompact) return null;
  const signal = new Array(values.length).fill(null);
  const first = line.findIndex(Number.isFinite);
  signalCompact.forEach((value, index) => { if (value != null) signal[first + index] = value; });
  const histogram = line.map((value, index) => value == null || signal[index] == null ? null : value - signal[index]);
  return { line, signal, histogram };
}

function directionLabel(value, deadZone = 0) {
  if (value > deadZone) return 'UP';
  if (value < -deadZone) return 'DOWN';
  return 'NEUTRAL';
}

function detectTriggers(candles, atrSeries, timeframe) {
  const triggers = [];
  for (let offset = 0; offset <= 2; offset += 1) {
    const index = candles.length - 1 - offset;
    if (index < 25) continue;
    const candle = candles[index];
    const previous = candles[index - 1];
    const history = candles.slice(index - 20, index);
    const priorHigh = Math.max(...history.map((item) => item.high));
    const priorLow = Math.min(...history.map((item) => item.low));
    const candleRange = Math.max(Number.EPSILON, candle.high - candle.low);
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const currentAtr = atrSeries[index] || average(history.map((item) => item.high - item.low));
    const volumeMean = average(history.map((item) => item.volume)) || 0;
    const volumeRatio = volumeMean > 0 ? candle.volume / volumeMean : 1;
    const recency = offset === 0 ? 3 : offset === 1 ? 2 : 1;
    const push = (type, direction, strength, detail, level = null) => triggers.push({
      type, direction, strength: strength + recency, timeframe,
      openTime: candle.openTime, closeTime: candle.closeTime,
      candle: { openTime: candle.openTime, closeTime: candle.closeTime, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
      level, priorRangeHigh: priorHigh, priorRangeLow: priorLow, detail,
    });

    if (candle.close > priorHigh && body >= currentAtr * 0.45) push('BREAKOUT', 'UP', 4, `close peste range-ul ultimelor 20 lumânări; volum ${round(volumeRatio)}x`, priorHigh);
    if (candle.close < priorLow && body >= currentAtr * 0.45) push('BREAKOUT', 'DOWN', 4, `close sub range-ul ultimelor 20 lumânări; volum ${round(volumeRatio)}x`, priorLow);
    if (candle.low < priorLow && candle.close > priorLow && lowerWick / candleRange >= 0.35) push('LIQUIDITY_SWEEP_RECLAIM', 'UP', 5, 'sweep sub minimul recent urmat de reclaim la close', priorLow);
    if (candle.high > priorHigh && candle.close < priorHigh && upperWick / candleRange >= 0.35) push('LIQUIDITY_SWEEP_RECLAIM', 'DOWN', 5, 'sweep peste maximul recent urmat de reclaim la close', priorHigh);
    if (body >= currentAtr * 1.2 && volumeRatio >= 1.1) push('DISPLACEMENT', candle.close > candle.open ? 'UP' : 'DOWN', 4, `corp ${round(body / currentAtr)} ATR; volum ${round(volumeRatio)}x`);
    const bullishEngulf = candle.close > candle.open && previous.close < previous.open && candle.open <= previous.close && candle.close >= previous.open;
    const bearishEngulf = candle.close < candle.open && previous.close > previous.open && candle.open >= previous.close && candle.close <= previous.open;
    if (bullishEngulf) push('ENGULFING', 'UP', 3, 'bullish engulfing pe lumânări închise');
    if (bearishEngulf) push('ENGULFING', 'DOWN', 3, 'bearish engulfing pe lumânări închise');
    if (lowerWick >= body * 1.8 && lowerWick / candleRange >= 0.5 && candle.close > candle.open) push('REJECTION_WICK', 'UP', 3, 'wick inferior respins și close bullish');
    if (upperWick >= body * 1.8 && upperWick / candleRange >= 0.5 && candle.close < candle.open) push('REJECTION_WICK', 'DOWN', 3, 'wick superior respins și close bearish');

    if (offset === 0) {
      for (let lookback = 1; lookback <= 3; lookback += 1) {
        const breakout = candles[index - lookback];
        const breakoutHistory = candles.slice(index - lookback - 20, index - lookback);
        if (breakoutHistory.length < 20) continue;
        const levelHigh = Math.max(...breakoutHistory.map((item) => item.high));
        const levelLow = Math.min(...breakoutHistory.map((item) => item.low));
        if (breakout.close > levelHigh && candle.low <= levelHigh && candle.close > levelHigh) push('BREAKOUT_RETEST', 'UP', 5, 'breakout anterior și retest menținut peste nivel', levelHigh);
        if (breakout.close < levelLow && candle.high >= levelLow && candle.close < levelLow) push('BREAKOUT_RETEST', 'DOWN', 5, 'breakdown anterior și retest menținut sub nivel', levelLow);
      }
    }
  }
  return triggers.sort((a, b) => b.closeTime - a.closeTime || b.strength - a.strength);
}

function analyzeTimeframe(candles, timeframe) {
  if (!Array.isArray(candles) || candles.length < 60) throw new Error(`${timeframe}: insufficient candles`);
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiSeries = rsi(closes);
  const macdSeries = macd(closes);
  const atrSeries = atr(candles);
  if (!ema9 || !ema20 || !ema50 || !rsiSeries || !macdSeries || !atrSeries) throw new Error(`${timeframe}: indicators unavailable`);
  const candle = last(candles);
  const previous = candles[candles.length - 2];
  const currentRsi = last(rsiSeries);
  const histogram = last(macdSeries.histogram);
  const previousHistogram = macdSeries.histogram[macdSeries.histogram.length - 2];
  const currentAtr = last(atrSeries);
  const volumeMean = average(volumes.slice(-21, -1)) || 0;
  const volumeRatio = volumeMean > 0 ? candle.volume / volumeMean : 1;
  const rangeWindow = candles.slice(-50);
  const rangeHigh = Math.max(...rangeWindow.map((item) => item.high));
  const rangeLow = Math.min(...rangeWindow.map((item) => item.low));
  const rangePosition = rangeHigh === rangeLow ? 0.5 : (candle.close - rangeLow) / (rangeHigh - rangeLow);
  const recent = candles.slice(-8);
  const older = candles.slice(-16, -8);
  const recentHigh = Math.max(...recent.map((item) => item.high));
  const recentLow = Math.min(...recent.map((item) => item.low));
  const olderHigh = Math.max(...older.map((item) => item.high));
  const olderLow = Math.min(...older.map((item) => item.low));
  const structure = recentHigh > olderHigh && recentLow > olderLow ? 'UP' : recentHigh < olderHigh && recentLow < olderLow ? 'DOWN' : 'NEUTRAL';
  const trendValue = (last(ema9) - last(ema20)) + (last(ema20) - last(ema50));
  const trend = directionLabel(trendValue, candle.close * 0.00035);
  const momentum = currentRsi >= 55 && histogram > 0 && histogram >= previousHistogram ? 'UP'
    : currentRsi <= 45 && histogram < 0 && histogram <= previousHistogram ? 'DOWN' : 'NEUTRAL';
  const volatilityPct = currentAtr / candle.close;
  const volatility = volatilityPct >= 0.0005 && volatilityPct <= 0.05 ? 'USABLE' : 'UNUSABLE';
  return {
    timeframe, closeTime: candle.closeTime, price: candle.close, usedCandleCount: candles.length,
    ema: { fast: round(last(ema9), 8), medium: round(last(ema20), 8), slow: round(last(ema50), 8) },
    overlay: { rangeHigh: round(rangeHigh, 8), rangeLow: round(rangeLow, 8), lastClose: round(candle.close, 8) },
    trend, trendStrengthPct: round(Math.abs(last(ema9) - last(ema50)) / candle.close * 100, 3),
    rsi: round(currentRsi), macd: { histogram: round(histogram, 8), accelerating: Math.abs(histogram) >= Math.abs(previousHistogram || 0) },
    momentum, atr: round(currentAtr, 8), atrPct: round(volatilityPct * 100, 3), volatility,
    volumeRatio: round(volumeRatio), volume: volumeRatio >= 1.15 ? (candle.close >= previous.close ? 'UP' : 'DOWN') : 'NEUTRAL',
    rangePosition: round(rangePosition, 3), structure,
    triggers: detectTriggers(candles, atrSeries, timeframe),
  };
}

function sanitizeInput(snapshot) {
  const { asOf, settleDelayMs = 0 } = snapshot;
  if (!Number.isFinite(asOf)) throw new Error('snapshot.asOf must be finite');
  const cutoff = asOf - settleDelayMs;
  const sanitized = {};
  for (const [timeframe, candles] of Object.entries(snapshot.candles || {})) {
    const deduped = new Map();
    for (const candle of candles || []) {
      const settlementTime = Number.isFinite(candle.endTime) ? candle.endTime : candle.closeTime;
      if (Number.isFinite(candle.closeTime) && Number.isFinite(settlementTime) && settlementTime <= cutoff) {
        deduped.set(candle.openTime, candle);
      }
    }
    sanitized[timeframe] = [...deduped.values()].sort((a, b) => a.openTime - b.openTime);
  }
  return sanitized;
}

function directionalComponents(analysis, direction) {
  let score = ['trend', 'momentum', 'structure'].filter((field) => analysis[field] === direction).length;
  if (analysis.volume === direction) score += 1;
  if (direction === 'UP' ? analysis.rangePosition >= 0.55 : analysis.rangePosition <= 0.45) score += 1;
  return score;
}

function addGate(gates, reasonCodes, code, pass, detail) {
  gates.push({ code, pass, detail });
  if (!pass) reasonCodes.push(code);
}

function decideHorizon({ symbol, horizon, analyses, metadata, asOf, generatedAt, minQuality }) {
  const spec = HORIZONS[horizon];
  const execution = spec.execution.map((timeframe) => analyses[timeframe]);
  const context = spec.context.map((timeframe) => analyses[timeframe]);
  const reasonCodes = [];
  const gateChecks = [];
  const invalidFrames = [...spec.execution, ...spec.context].filter((timeframe) => {
    const item = metadata[timeframe];
    return !item || item.closed !== true || item.valid !== true || item.fresh !== true || (item.gaps || 0) > 0;
  });
  addGate(gateChecks, reasonCodes, 'DATA_STALE_OR_GAPPED', invalidFrames.length === 0, invalidFrames.length ? `TF invalide: ${invalidFrames.join(', ')}` : 'toate TF sunt closed, fresh și continue în întreaga fereastră analizată');

  const recentTriggers = spec.triggerFrames
    .flatMap((timeframe) => analyses[timeframe].triggers)
    .filter((trigger) => trigger.closeTime <= asOf && asOf - trigger.closeTime <= spec.triggerMaxAgeMs)
    .sort((a, b) => b.closeTime - a.closeTime || b.strength - a.strength);
  const bestTrigger = recentTriggers[0] || null;
  addGate(gateChecks, reasonCodes, 'TRIGGER_MISSING_OR_STALE', Boolean(bestTrigger), bestTrigger
    ? `${bestTrigger.type} ${bestTrigger.direction} ${bestTrigger.timeframe}, age ${Math.max(0, asOf - bestTrigger.closeTime)}ms`
    : `niciun trigger în ultimele ${spec.triggerMaxAgeMs / 60_000} minute`);
  const candidate = bestTrigger ? bestTrigger.direction : 'WAIT';
  const opposingTriggers = bestTrigger ? recentTriggers.filter((trigger) => trigger.direction !== candidate) : [];
  const materialOpposing = bestTrigger ? opposingTriggers.find((trigger) => trigger.strength >= bestTrigger.strength - 1) : null;
  addGate(gateChecks, reasonCodes, 'TRIGGER_CONFLICT', !materialOpposing, materialOpposing
    ? `${materialOpposing.type} ${materialOpposing.direction} ${materialOpposing.timeframe}, strength ${materialOpposing.strength}`
    : 'fără trigger opus material în fereastra relevantă');

  let bullish = 0;
  let bearish = 0;
  for (const analysis of execution) {
    const frameWeight = analysis.timeframe === '1m' ? 1 : 1.25;
    for (const field of ['trend', 'momentum', 'structure']) {
      if (analysis[field] === 'UP') bullish += frameWeight;
      if (analysis[field] === 'DOWN') bearish += frameWeight;
    }
    if (analysis.volume === 'UP') bullish += 0.8;
    if (analysis.volume === 'DOWN') bearish += 0.8;
    if (analysis.rangePosition >= 0.58) bullish += 0.5;
    if (analysis.rangePosition <= 0.42) bearish += 0.5;
  }
  const margin = round(Math.abs(bullish - bearish));
  const aggregateDirection = bullish > bearish ? 'UP' : bearish > bullish ? 'DOWN' : 'WAIT';
  const confirmingTimeframes = candidate === 'WAIT' ? [] : execution.filter((analysis) => directionalComponents(analysis, candidate) >= 2).map((analysis) => analysis.timeframe);
  const opposingTimeframes = candidate === 'WAIT' ? [] : execution.filter((analysis) => directionalComponents(analysis, candidate === 'UP' ? 'DOWN' : 'UP') >= 2).map((analysis) => analysis.timeframe);
  addGate(gateChecks, reasonCodes, 'EXECUTION_TF_CONFIRMATIONS_LT_2', confirmingTimeframes.length >= 2,
    `${confirmingTimeframes.length}/${execution.length} TF distincte confirmă: ${confirmingTimeframes.join(', ') || 'niciunul'}`);
  const frameBiases = execution.map((analysis) => ({
    timeframe: analysis.timeframe,
    up: directionalComponents(analysis, 'UP'),
    down: directionalComponents(analysis, 'DOWN'),
  }));
  const hasUpFrame = frameBiases.some((item) => item.up >= 2 && item.up > item.down);
  const hasDownFrame = frameBiases.some((item) => item.down >= 2 && item.down > item.up);
  const materialExecutionConflict = hasUpFrame && hasDownFrame;
  addGate(gateChecks, reasonCodes, 'EXECUTION_TF_CONFLICT', !materialExecutionConflict,
    materialExecutionConflict ? 'TF-urile de execuție au biasuri materiale opuse' : 'fără conflict material între TF-urile de execuție');
  const unusableFrames = execution.filter((analysis) => analysis.volatility !== 'USABLE').map((analysis) => analysis.timeframe);
  const directionalFrames = frameBiases.filter((item) => Math.max(item.up, item.down) >= 2).length;
  const chopOrUnusable = unusableFrames.length > 0 || directionalFrames < 2;
  addGate(gateChecks, reasonCodes, 'CHOP_OR_VOLATILITY_UNUSABLE', !chopOrUnusable,
    unusableFrames.length ? `volatilitate neutilizabilă: ${unusableFrames.join(', ')}` : directionalFrames < 2 ? 'chop: mai puțin de 2 TF au structură direcțională' : 'volatilitate și structură utilizabile');

  const opposite = candidate === 'UP' ? 'DOWN' : 'UP';
  const hardHigherConflict = candidate !== 'WAIT' && context.some((analysis) => analysis.trend === opposite
    && (analysis.momentum === opposite || analysis.structure === opposite) && analysis.trendStrengthPct >= 0.08);
  addGate(gateChecks, reasonCodes, 'HIGHER_TF_CONFLICT', !hardHigherConflict,
    hardHigherConflict ? 'contextul higher-TF este material opus' : 'fără conflict material higher-TF');
  addGate(gateChecks, reasonCodes, 'DIRECTIONAL_CONFLICT', candidate !== 'WAIT' && aggregateDirection === candidate,
    `trigger=${candidate}, agregat=${aggregateDirection}`);
  addGate(gateChecks, reasonCodes, 'MARGIN_LOW', margin >= 1.5, `margin=${margin}`);

  const evidence = [];
  const conflicts = [];
  const confirmations = new Set();
  if (candidate !== 'WAIT') {
    for (const field of ['trend', 'momentum', 'structure', 'volume']) {
      const frames = execution.filter((analysis) => analysis[field] === candidate).map((analysis) => analysis.timeframe);
      if (frames.length) { confirmations.add(field); evidence.push(`${field} ${candidate}: ${frames.join(', ')}`); }
    }
    const rangeFrames = execution.filter((analysis) => candidate === 'UP' ? analysis.rangePosition >= 0.55 : analysis.rangePosition <= 0.45).map((analysis) => analysis.timeframe);
    if (rangeFrames.length) { confirmations.add('range'); evidence.push(`range favorabil: ${rangeFrames.join(', ')}`); }
    opposingTimeframes.forEach((timeframe) => conflicts.push(`${timeframe}: confirmare materială ${opposite}`));
  }
  context.forEach((analysis) => {
    if (candidate !== 'WAIT' && analysis.trend === candidate) evidence.push(`${analysis.timeframe}: context trend ${candidate}`);
    else if (candidate !== 'WAIT' && analysis.trend !== 'NEUTRAL') conflicts.push(`${analysis.timeframe}: context trend ${analysis.trend}`);
  });
  if (materialOpposing) conflicts.push(`${materialOpposing.timeframe}: trigger opus ${materialOpposing.type}`);

  const quality = Math.max(0, Math.min(100, Math.round(
    34 + (bestTrigger ? Math.min(18, bestTrigger.strength * 2) : 0)
    + confirmingTimeframes.length * 10 + confirmations.size * 4 + Math.min(10, margin * 2)
    + context.filter((analysis) => analysis.trend === candidate).length * 5
    - opposingTimeframes.length * 7 - (materialOpposing ? 12 : 0) - (hardHigherConflict ? 20 : 0) - (chopOrUnusable ? 12 : 0)
  )));
  addGate(gateChecks, reasonCodes, 'QUALITY_BELOW_THRESHOLD', quality >= minQuality, `quality=${quality}, prag=${minQuality}`);
  const uniqueReasonCodes = [...new Set(reasonCodes)];
  const verdict = uniqueReasonCodes.length ? 'WAIT' : candidate;
  const action = verdict === 'WAIT' ? 'WAIT' : 'ENTER';
  const direction = verdict === 'WAIT' ? null : verdict;
  const bias = candidate !== 'WAIT' ? candidate : aggregateDirection === 'WAIT' ? 'NEUTRAL' : aggregateDirection;
  const latestCloseTime = Math.max(...spec.execution.map((timeframe) => analyses[timeframe].closeTime));
  const timing = contractBoundaries(generatedAt, horizon);
  const signalKey = action === 'WAIT' || !bestTrigger ? null : `${symbol}:${horizon}m:${direction}:${bestTrigger.type}:${bestTrigger.closeTime}`;
  return {
    symbol, horizonMin: horizon, action, direction, bias, verdict, quality,
    qualityLabel: 'quality/confluence (nu probabilitate)', scoreMargin: margin,
    reasonCodes: uniqueReasonCodes.length ? uniqueReasonCodes : ['SIGNAL_GATES_PASSED'], gateChecks,
    trigger: bestTrigger ? { ...bestTrigger, ageMs: Math.max(0, asOf - bestTrigger.closeTime) } : null,
    triggerAgeMs: bestTrigger ? Math.max(0, asOf - bestTrigger.closeTime) : null,
    triggerWindowMs: spec.triggerMaxAgeMs,
    confirmingTimeframes, opposingTimeframes,
    confirmations: [...confirmations], evidence, conflicts,
    timeframeAnalyses: Object.fromEntries([...spec.execution, ...spec.context].map((timeframe) => [timeframe, analyses[timeframe]])),
    invalidation: candidate === 'UP' ? 'invalidare: close sub minimul triggerului sau conflict superior nou'
      : candidate === 'DOWN' ? 'invalidare: close peste maximul triggerului sau conflict superior nou' : 'așteaptă trigger și confirmări noi',
    context: context.map((analysis) => `${analysis.timeframe} trend=${analysis.trend}, momentum=${analysis.momentum}`).join('; '),
    signalKey, price: analyses[spec.execution[0]].price, latestClosedCandleTime: latestCloseTime,
    asOf, generatedAt, entryBoundaryOpenTime: timing.entryOpenTime, expiryEstimateCloseTime: timing.expiryCloseTime,
  };
}

function analyzeSnapshot(snapshot, options = {}) {
  const generatedAt = Number.isFinite(snapshot.generatedAt) ? snapshot.generatedAt : snapshot.asOf;
  const candles = sanitizeInput({ ...snapshot, asOf: generatedAt });
  const required = [...new Set(Object.values(HORIZONS).flatMap((spec) => [...spec.execution, ...spec.context]))];
  const analyses = {};
  for (const timeframe of required) {
    const series = candles[timeframe] || [];
    if (series.length < ANALYSIS_CANDLE_COUNT) throw new Error(`${timeframe}: need ${ANALYSIS_CANDLE_COUNT} closed candles, received ${series.length}`);
    analyses[timeframe] = analyzeTimeframe(series.slice(-ANALYSIS_CANDLE_COUNT), timeframe);
  }
  return {
    symbol: snapshot.symbol, asOf: generatedAt, generatedAt, source: snapshot.source, metadata: snapshot.metadata,
    predictions: {
      '10m': decideHorizon({ symbol: snapshot.symbol, horizon: 10, analyses, metadata: snapshot.metadata || {}, asOf: generatedAt, generatedAt, minQuality: Number.isFinite(options.minQuality10) ? options.minQuality10 : 65 }),
      '30m': decideHorizon({ symbol: snapshot.symbol, horizon: 30, analyses, metadata: snapshot.metadata || {}, asOf: generatedAt, generatedAt, minQuality: Number.isFinite(options.minQuality30) ? options.minQuality30 : 68 }),
    },
  };
}

module.exports = {
  HORIZONS, ANALYSIS_CANDLE_COUNT, analyzeSnapshot, analyzeTimeframe, sanitizeInput, detectTriggers, decideHorizon,
  indicators: { ema, rsi, atr, macd },
};
