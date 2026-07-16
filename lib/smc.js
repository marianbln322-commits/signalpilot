'use strict';

// ============================================================================
// smc.js — Smart Money Concepts detected deterministically from candles.
//   - swing points (fractals)
//   - market structure (HH/HL/LH/LL) + Market Structure Shift / CHoCH
//   - Fair Value Gaps (FVG) + Inversion FVG (IFVG)
//   - Liquidity Sweep / Swing Failure Pattern (SFP)
// Each detector returns plain objects the decision engine can score.
// ============================================================================

// ---- Swing points via a simple fractal (lookback/lookforward = span) --------
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

// ---- Market structure classification ---------------------------------------
// Returns { trend: 'up'|'down'|'range', mss: 'bullish'|'bearish'|null, detail }
function marketStructure(candles, span = 2) {
  const { highs, lows } = swings(candles, span);
  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'range', mss: null, detail: 'insufficient swings', highs, lows };
  }
  const h1 = highs[highs.length - 2].price;
  const h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price;
  const l2 = lows[lows.length - 1].price;

  const higherHighs = h2 > h1;
  const higherLows = l2 > l1;
  const lowerHighs = h2 < h1;
  const lowerLows = l2 < l1;

  let trend = 'range';
  if (higherHighs && higherLows) trend = 'up';
  else if (lowerHighs && lowerLows) trend = 'down';

  // Market Structure Shift: latest close breaks the prior opposing swing.
  const lastClose = candles[candles.length - 1].close;
  const lastSwingHigh = highs[highs.length - 1].price;
  const lastSwingLow = lows[lows.length - 1].price;
  let mss = null;
  // Bullish MSS: in a down/range context, close breaks the most recent swing high.
  if (lastClose > lastSwingHigh && (trend === 'down' || trend === 'range')) mss = 'bullish';
  // Bearish MSS: in an up/range context, close breaks the most recent swing low.
  if (lastClose < lastSwingLow && (trend === 'up' || trend === 'range')) mss = 'bearish';

  return {
    trend,
    mss,
    detail: { higherHighs, higherLows, lowerHighs, lowerLows, lastSwingHigh, lastSwingLow },
    highs,
    lows,
  };
}

// ---- Fair Value Gaps --------------------------------------------------------
// A 3-candle imbalance. Bullish: low[i] > high[i-2]. Bearish: high[i] < low[i-2].
// We return recent gaps that are still at least partially unfilled, plus whether
// price is currently retesting one, and detect Inversion FVGs (invalidated gaps).
function fairValueGaps(candles, lookback = 60) {
  const start = Math.max(2, candles.length - lookback);
  const gaps = [];
  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    // Bullish FVG
    if (c.low > a.high) {
      gaps.push({ type: 'bullish', top: c.low, bottom: a.high, index: i });
    }
    // Bearish FVG
    if (c.high < a.low) {
      gaps.push({ type: 'bearish', top: a.low, bottom: c.high, index: i });
    }
  }

  const lastClose = candles[candles.length - 1].close;
  const lastHigh = candles[candles.length - 1].high;
  const lastLow = candles[candles.length - 1].low;

  // Determine fill / inversion status for each gap based on subsequent price.
  const enriched = gaps.map((g) => {
    let inverted = false;
    for (let k = g.index + 1; k < candles.length; k++) {
      const cl = candles[k].close;
      if (g.type === 'bullish' && cl < g.bottom) inverted = true; // bullish gap failed
      if (g.type === 'bearish' && cl > g.top) inverted = true; // bearish gap failed
    }
    // effective type after inversion (IFVG flips polarity)
    const effectiveType = inverted ? (g.type === 'bullish' ? 'bearish' : 'bullish') : g.type;
    return { ...g, inverted, effectiveType };
  });

  // Is price currently inside a gap (retest)?
  const retest = enriched.find(
    (g) => lastLow <= g.top && lastHigh >= g.bottom
  ) || null;

  return { gaps: enriched, retest, lastClose };
}

// ---- Liquidity Sweep / Swing Failure Pattern --------------------------------
// Looks at the last (just-closed) candle: does it pierce a recent swing level
// with a long wick but close back inside, ideally on above-average volume?
function liquiditySweep(candles, opts = {}) {
  const span = opts.span || 2;
  const volAvg = opts.volAvg || null; // average volume for spike comparison
  const n = candles.length;
  if (n < 6) return null;
  const { highs, lows } = swings(candles.slice(0, n - 1), span); // swings before last candle
  const last = candles[n - 1];
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const range = last.high - last.low || 1e-9;

  const volSpike = volAvg ? last.volume > volAvg * 1.3 : false;

  // Bullish sweep: pierced below a recent swing low but closed back above it,
  // with a dominant lower wick (rejection of sell-side liquidity).
  const recentLow = lows.length ? lows[lows.length - 1].price : null;
  if (
    recentLow != null &&
    last.low < recentLow &&
    last.close > recentLow &&
    lowerWick > body &&
    lowerWick / range > 0.5
  ) {
    return {
      type: 'bullish',
      sweptLevel: recentLow,
      wickExtreme: last.low,
      volSpike,
      strength: (lowerWick / range) + (volSpike ? 0.5 : 0),
    };
  }

  // Bearish sweep: pierced above a recent swing high but closed back below it.
  const recentHigh = highs.length ? highs[highs.length - 1].price : null;
  if (
    recentHigh != null &&
    last.high > recentHigh &&
    last.close < recentHigh &&
    upperWick > body &&
    upperWick / range > 0.5
  ) {
    return {
      type: 'bearish',
      sweptLevel: recentHigh,
      wickExtreme: last.high,
      volSpike,
      strength: (upperWick / range) + (volSpike ? 0.5 : 0),
    };
  }

  return null;
}

// ---- Equal highs / lows (liquidity pools) -----------------------------------
function equalLevels(candles, span = 2, tolerancePct = 0.0008) {
  const { highs, lows } = swings(candles, span);
  const equalHighs = [];
  const equalLows = [];
  for (let i = 1; i < highs.length; i++) {
    if (Math.abs(highs[i].price - highs[i - 1].price) / highs[i].price < tolerancePct) {
      equalHighs.push(highs[i].price);
    }
  }
  for (let i = 1; i < lows.length; i++) {
    if (Math.abs(lows[i].price - lows[i - 1].price) / lows[i].price < tolerancePct) {
      equalLows.push(lows[i].price);
    }
  }
  return { equalHighs, equalLows };
}

module.exports = {
  swings,
  marketStructure,
  fairValueGaps,
  liquiditySweep,
  equalLevels,
};
