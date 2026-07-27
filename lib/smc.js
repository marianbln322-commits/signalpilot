'use strict';

// Deterministic Smart Money Concepts. Every event is based on closed candles;
// callers are responsible for removing the currently-forming bar.

function swings(candles, span = 2) {
  const highsArr = [];
  const lowsArr = [];
  for (let i = span; i < candles.length - span; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highsArr.push({ index: i, price: candles[i].high });
    if (isLow) lowsArr.push({ index: i, price: candles[i].low });
  }
  return { highs: highsArr, lows: lowsArr };
}

// A structure shift is an event, not a persistent state: the previous close
// must have been inside the level and the latest close must cross it.
function marketStructure(candles, span = 2) {
  const { highs, lows } = swings(candles, span);
  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'range', mss: null, detail: 'insufficient swings', highs, lows };
  }

  const h1 = highs.at(-2).price;
  const h2 = highs.at(-1).price;
  const l1 = lows.at(-2).price;
  const l2 = lows.at(-1).price;
  const higherHighs = h2 > h1;
  const higherLows = l2 > l1;
  const lowerHighs = h2 < h1;
  const lowerLows = l2 < l1;

  let trend = 'range';
  if (higherHighs && higherLows) trend = 'up';
  else if (lowerHighs && lowerLows) trend = 'down';

  const lastClose = candles.at(-1).close;
  const prevClose = candles.at(-2).close;
  const lastSwingHigh = highs.at(-1).price;
  const lastSwingLow = lows.at(-1).price;
  let mss = null;
  if (prevClose <= lastSwingHigh && lastClose > lastSwingHigh && trend !== 'up') mss = 'bullish';
  else if (prevClose >= lastSwingLow && lastClose < lastSwingLow && trend !== 'down') mss = 'bearish';

  return {
    trend,
    mss,
    detail: { higherHighs, higherLows, lowerHighs, lowerLows, lastSwingHigh, lastSwingLow },
    highs,
    lows,
  };
}

// FVG lifecycle: created -> partial fill OR invalidated -> later IFVG retest.
// A gap can never retest itself on the creation/invalidation candle.
function fairValueGaps(candles, lookback = 60, opts = {}) {
  const start = Math.max(2, candles.length - lookback);
  const latestIndex = candles.length - 1;
  const atr = Number(opts.atr) || 0;
  const minGapAtr = opts.minGapAtr == null ? 0.1 : Number(opts.minGapAtr);
  const maxAge = opts.maxAge == null ? 40 : Number(opts.maxAge);
  const gaps = [];

  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    if (c.low > a.high) {
      const size = c.low - a.high;
      if (!atr || size / atr >= minGapAtr) gaps.push({ type: 'bullish', top: c.low, bottom: a.high, size, index: i });
    }
    if (c.high < a.low) {
      const size = a.low - c.high;
      if (!atr || size / atr >= minGapAtr) gaps.push({ type: 'bearish', top: a.low, bottom: c.high, size, index: i });
    }
  }

  const enriched = gaps.map((g) => {
    let inversionIndex = null;
    let inversionRetestIndex = null;
    let firstTouchIndex = null;
    let fullyFilledIndex = null;
    for (let k = g.index + 1; k < candles.length; k++) {
      const bar = candles[k];
      const touches = bar.low <= g.top && bar.high >= g.bottom;
      if (touches && firstTouchIndex == null) firstTouchIndex = k;
      if (touches && inversionIndex != null && k > inversionIndex && inversionRetestIndex == null) inversionRetestIndex = k;
      if (g.type === 'bullish') {
        if (bar.low <= g.bottom && fullyFilledIndex == null) fullyFilledIndex = k;
        if (bar.close < g.bottom && inversionIndex == null) inversionIndex = k;
      } else {
        if (bar.high >= g.top && fullyFilledIndex == null) fullyFilledIndex = k;
        if (bar.close > g.top && inversionIndex == null) inversionIndex = k;
      }
    }
    const inverted = inversionIndex != null;
    return {
      ...g,
      age: latestIndex - g.index,
      firstTouchIndex,
      fullyFilledIndex,
      inversionIndex,
      inversionRetestIndex,
      inverted,
      effectiveType: inverted ? (g.type === 'bullish' ? 'bearish' : 'bullish') : g.type,
    };
  });

  const last = candles.at(-1);
  const candidates = enriched.filter((g) => {
    if (g.age > maxAge || g.index >= latestIndex) return false;
    const intersects = last.low <= g.top && last.high >= g.bottom;
    if (!intersects) return false;
    if (g.inverted) return g.inversionRetestIndex === latestIndex;
    return g.firstTouchIndex === latestIndex;
  });
  const retest = candidates.sort((a, b) => b.index - a.index)[0] || null;

  return { gaps: enriched, retest, lastClose: last.close };
}

function liquiditySweep(candles, opts = {}) {
  const span = opts.span || 2;
  const volAvg = opts.volAvg || null;
  const n = candles.length;
  if (n < 6) return null;
  const { highs, lows } = swings(candles.slice(0, n - 1), span);
  const last = candles[n - 1];
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const range = last.high - last.low || 1e-9;
  const volSpike = volAvg ? last.volume > volAvg * 1.3 : false;

  const recentLow = lows.length ? lows.at(-1).price : null;
  if (recentLow != null && last.low < recentLow && last.close > recentLow &&
      lowerWick > body && lowerWick / range > 0.5) {
    return {
      type: 'bullish', sweptLevel: recentLow, wickExtreme: last.low, volSpike,
      strength: lowerWick / range + (volSpike ? 0.5 : 0),
    };
  }

  const recentHigh = highs.length ? highs.at(-1).price : null;
  if (recentHigh != null && last.high > recentHigh && last.close < recentHigh &&
      upperWick > body && upperWick / range > 0.5) {
    return {
      type: 'bearish', sweptLevel: recentHigh, wickExtreme: last.high, volSpike,
      strength: upperWick / range + (volSpike ? 0.5 : 0),
    };
  }
  return null;
}

function equalLevels(candles, span = 2, tolerancePct = 0.0008) {
  const { highs, lows } = swings(candles, span);
  const equalHighs = [];
  const equalLows = [];
  for (let i = 1; i < highs.length; i++) {
    if (Math.abs(highs[i].price - highs[i - 1].price) / highs[i].price < tolerancePct) equalHighs.push(highs[i].price);
  }
  for (let i = 1; i < lows.length; i++) {
    if (Math.abs(lows[i].price - lows[i - 1].price) / lows[i].price < tolerancePct) equalLows.push(lows[i].price);
  }
  return { equalHighs, equalLows };
}

module.exports = { swings, marketStructure, fairValueGaps, liquiditySweep, equalLevels };
