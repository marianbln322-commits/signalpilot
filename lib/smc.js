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
  //
  // IMPORTANT: an MSS is an EVENT, not a state. The previous version only
  // checked `lastClose > lastSwingHigh`, which stays true for every bar that
  // price holds above the level — so a single break kept injecting weight into
  // the score for dozens of consecutive bars, inflating confluence. We now
  // require the break to be NEW: the prior bar must still have been on the other
  // side of the level. `mssState` keeps the persistent view for display.
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx].close;
  const prevClose = lastIdx > 0 ? candles[lastIdx - 1].close : lastClose;
  const lastSwingHigh = highs[highs.length - 1].price;
  const lastSwingLow = lows[lows.length - 1].price;

  let mssState = null;
  if (lastClose > lastSwingHigh && (trend === 'down' || trend === 'range')) mssState = 'bullish';
  if (lastClose < lastSwingLow && (trend === 'up' || trend === 'range')) mssState = 'bearish';

  let mss = null;
  if (mssState === 'bullish' && prevClose <= lastSwingHigh) mss = 'bullish';
  if (mssState === 'bearish' && prevClose >= lastSwingLow) mss = 'bearish';

  return {
    trend,
    mss,        // fresh break on this bar only (a trigger)
    mssState,   // persistent "price is beyond the level" view (context)
    detail: { higherHighs, higherLows, lowerHighs, lowerLows, lastSwingHigh, lastSwingLow },
    highs,
    lows,
  };
}

// ---- Fair Value Gaps --------------------------------------------------------
// A 3-candle imbalance. Bullish: low[i] > high[i-2]. Bearish: high[i] < low[i-2].
//
// Lifecycle of a gap (this is what the previous version got wrong — it tracked
// inversion but never tracked FILLING, so a gap that had been fully consumed
// weeks ago still counted as a live "retest"):
//   fresh      -> price has not returned into the zone yet
//   retesting  -> price is inside the zone right now (tradeable)
//   filled     -> price reached the far edge; the imbalance is spent (NOT tradeable)
//   inverted   -> price CLOSED through the zone; polarity flips (IFVG, tradeable)
// `opts.atr` enables the significance filters described below. Without it the
// function degrades to the raw 3-bar pattern (kept only for compatibility).
function fairValueGaps(candles, lookback = 60, opts = {}) {
  const atr = Number.isFinite(opts.atr) && opts.atr > 0 ? opts.atr : null;
  // A Fair Value Gap is supposed to mark DISPLACEMENT — a violent, one-sided move
  // that leaves unfilled orders behind. The mechanical "low[i] > high[i-2]" test
  // alone matches a huge number of trivial 3-bar patterns: measured on 4000 bars,
  // price sat inside some qualifying gap 76% of the time, and FVG/IFVG accounted
  // for 93% of all triggers, drowning out every other setup. That is ambient
  // noise being reported as a signal.
  //
  // Two significance filters restore the intended meaning:
  //   minGapAtr          - the gap itself must be a real void, not a rounding error
  //   minDisplacementAtr - the middle candle must be an expansion candle
  const minGapAtr = opts.minGapAtr != null ? opts.minGapAtr : 0.35;
  const minDisplacementAtr = opts.minDisplacementAtr != null ? opts.minDisplacementAtr : 0.9;

  const start = Math.max(2, candles.length - lookback);
  const gaps = [];
  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2];
    const mid = candles[i - 1];
    const c = candles[i];
    const displacement = Math.abs(mid.close - mid.open);

    // Bullish FVG: imbalance left BELOW price.
    if (c.low > a.high) {
      const size = c.low - a.high;
      if (!atr || (size >= minGapAtr * atr && displacement >= minDisplacementAtr * atr)) {
        gaps.push({ type: 'bullish', top: c.low, bottom: a.high, index: i, size, displacement });
      }
    }
    // Bearish FVG: imbalance left ABOVE price.
    if (c.high < a.low) {
      const size = a.low - c.high;
      if (!atr || (size >= minGapAtr * atr && displacement >= minDisplacementAtr * atr)) {
        gaps.push({ type: 'bearish', top: a.low, bottom: c.high, index: i, size, displacement });
      }
    }
  }

  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx].close;
  const lastHigh = candles[lastIdx].high;
  const lastLow = candles[lastIdx].low;

  // Maximum age (in bars) for a gap, or for an inversion, to still be relevant.
  const maxAge = opts.maxAge != null ? opts.maxAge : 30;
  const maxInversionAge = opts.maxInversionAge != null ? opts.maxInversionAge : 12;

  const inZone = (candle, g) => candle.low <= g.top && candle.high >= g.bottom;

  const enriched = gaps.map((g) => {
    let touchedAt = null;        // first re-entry into the zone
    let filledAt = null;         // first time the far edge was reached
    let invertedAt = null;       // first CLOSE beyond the zone (polarity flip)
    let postInversionTouchAt = null; // first re-entry AFTER the flip

    for (let k = g.index + 1; k < candles.length; k++) {
      const c = candles[k];
      const cl = c.close;
      if (touchedAt == null && inZone(c, g)) touchedAt = k;
      if (g.type === 'bullish') {
        if (filledAt == null && c.low <= g.bottom) filledAt = k;
        if (invertedAt == null && cl < g.bottom) invertedAt = k;
      } else {
        if (filledAt == null && c.high >= g.top) filledAt = k;
        if (invertedAt == null && cl > g.top) invertedAt = k;
      }
      if (invertedAt != null && k > invertedAt && postInversionTouchAt == null && inZone(c, g)) {
        postInversionTouchAt = k;
      }
    }

    const inverted = invertedAt != null;
    const effectiveType = inverted ? (g.type === 'bullish' ? 'bearish' : 'bullish') : g.type;

    // A gap is only ACTIONABLE on a specific bar, not permanently:
    //
    //   plain FVG -> the FIRST time price returns into an unmitigated gap.
    //   IFVG      -> the FIRST return after a recent polarity flip.
    //
    // Without this, a single gap kept re-emitting a signal on every bar price
    // happened to drift through it. Because almost every gap eventually gets
    // closed through on a long enough lookback, nearly all of them ended up
    // classified as tradeable inversions: FVG/IFVG produced 88-93% of all
    // triggers and masked every other setup.
    let actionable = false;
    let reason = null;
    if (inverted) {
      const freshFlip = lastIdx - invertedAt <= maxInversionAge;
      if (freshFlip && postInversionTouchAt === lastIdx) {
        actionable = true;
        reason = 'primul retest după inversare';
      }
    } else if (filledAt == null || filledAt === lastIdx) {
      const fresh = lastIdx - g.index <= maxAge;
      if (fresh && touchedAt === lastIdx) {
        actionable = true;
        reason = 'primul retest al gap-ului nemitigat';
      }
    }

    return {
      ...g,
      inverted,
      invertedAt,
      filled: filledAt != null,
      filledAt,
      touchedAt,
      spent: filledAt != null && invertedAt == null,
      actionable,
      reason,
      effectiveType,
      age: lastIdx - g.index,
    };
  });

  // Only gaps that are actionable ON THIS BAR, and price is currently inside.
  const candidates = enriched.filter((g) => g.actionable && lastLow <= g.top && lastHigh >= g.bottom);
  // Pick the MOST RECENT one. The previous version used .find(), which returned
  // the OLDEST match — usually a stale, irrelevant gap.
  const retest = candidates.length
    ? candidates.reduce((best, g) => (g.index > best.index ? g : best), candidates[0])
    : null;

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
