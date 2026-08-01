'use strict';
(function (global) {
  const modules = Object.create(null);
  const cache = Object.create(null);
  function define(id, factory) { modules[id] = factory; }
  function resolve(from, request) {
    if (!request.startsWith('.')) return request;
    const base = from.split('/');
    base.pop();
    for (const part of request.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') base.pop();
      else base.push(part);
    }
    const id = base.join('/');
    return id.endsWith('.js') ? id : id + '.js';
  }
  function load(id) {
    if (cache[id]) return cache[id].exports;
    if (!modules[id]) throw new Error('Mobile bundle module not found: ' + id);
    const module = { exports: {} };
    cache[id] = module;
    modules[id](module, module.exports, (request) => load(resolve(id, request)));
    return module.exports;
  }
  define("lib/indicators.js", function (module, exports, require) {
'use strict';

// ============================================================================
// indicators.js — deterministic technical indicators computed from OHLCV data.
// All functions take arrays of numbers and return either a full series or the
// latest value(s). No guessing, no image parsing — pure math on real candles.
// ============================================================================

function sma(values, period) {
  if (!values || values.length < period) return null;
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  if (!values || values.length < period) return null;
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// Wilder's RSI.
function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const out = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// MACD: returns { macd, signal, histogram } as aligned series.
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!closes || closes.length < slow + signalPeriod) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const macdValues = macdLine.filter((v) => v != null);
  const signalRaw = ema(macdValues, signalPeriod);
  // Re-align signal to the full length.
  const firstIdx = macdLine.findIndex((v) => v != null);
  const signalLine = new Array(closes.length).fill(null);
  if (signalRaw) {
    for (let i = 0; i < signalRaw.length; i++) {
      if (signalRaw[i] != null) signalLine[firstIdx + i] = signalRaw[i];
    }
  }
  const histogram = closes.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null
  );
  return { macd: macdLine, signal: signalLine, histogram };
}

// Bollinger Bands: returns { upper, mid, lower, bandwidth } series.
function bollinger(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const bandwidth = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    const m = mid[i];
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - m) ** 2;
    const sd = Math.sqrt(sumSq / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    bandwidth[i] = m !== 0 ? (upper[i] - lower[i]) / m : 0;
  }
  return { upper, mid, lower, bandwidth };
}

// Average True Range (Wilder).
function atr(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const tr = new Array(closes.length).fill(null);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < closes.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

// Rolling average of volume (excludes the current forming candle when asked).
function volumeAverage(volumes, period = 20) {
  return sma(volumes, period);
}

// Rolling VWAP (Volume-Weighted Average Price) over the last `period` bars.
// The intraday "fair value" anchor scalpers watch: price above a rising VWAP is
// a bullish bias, below a falling VWAP is bearish.
function vwap(candles, period = 96) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - period + 1);
    let pv = 0;
    let vol = 0;
    for (let j = start; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      pv += tp * candles[j].volume;
      vol += candles[j].volume;
    }
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

// Convenience: last non-null value of a series.
function last(series) {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}

module.exports = {
  sma,
  ema,
  rsi,
  macd,
  bollinger,
  atr,
  volumeAverage,
  vwap,
  last,
};

  });
  define("lib/smc.js", function (module, exports, require) {
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

  });
  define("lib/engine.js", function (module, exports, require) {
'use strict';

// ============================================================================
// engine.js — the decision brain.
// Combines deterministic indicators + SMC into a single UP/DOWN verdict using
// weighted confluence, following the priority from the methodology:
//   price action / SMC first, oscillators as confirmation.
// Output is the strict 5-step format:
//   { directie, interval, justificare, incredere, invalidare, ... }
// Every number comes from real candles; nothing is invented.
// ============================================================================

const ind = require('./indicators');
const smc = require('./smc');

// ---- RSI divergence (regular) ----------------------------------------------
function rsiDivergence(candles, rsiSeries, span = 2) {
  const { highs, lows } = smc.swings(candles, span);
  const out = { bullish: false, bearish: false };
  if (highs.length >= 2) {
    const a = highs[highs.length - 2];
    const b = highs[highs.length - 1];
    const ra = rsiSeries[a.index];
    const rb = rsiSeries[b.index];
    if (ra != null && rb != null && b.price > a.price && rb < ra) out.bearish = true;
  }
  if (lows.length >= 2) {
    const a = lows[lows.length - 2];
    const b = lows[lows.length - 1];
    const ra = rsiSeries[a.index];
    const rb = rsiSeries[b.index];
    if (ra != null && rb != null && b.price < a.price && rb > ra) out.bullish = true;
  }
  return out;
}

// Analyze one timeframe and return { signals, snapshot }.
function analyzeTimeframe(candles, tf, kindOfTf) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const rsi14 = ind.rsi(closes, 14) || [];
  const macd = ind.macd(closes) || { macd: [], signal: [], histogram: [] };
  const bb = ind.bollinger(closes, 20, 2) || { upper: [], mid: [], lower: [], bandwidth: [] };
  const ema9 = ind.ema(closes, 9) || [];
  const ema20 = ind.ema(closes, 20) || [];
  const ema50 = ind.ema(closes, 50) || [];
  const volAvg = ind.volumeAverage(volumes, 20) || [];
  const vwapSeries = ind.vwap(candles, 96) || [];

  const iLast = candles.length - 1;
  const price = closes[iLast];
  const rsiNow = ind.last(rsi14);
  const rsiPrev = rsi14[iLast - 1];
  const macdNow = macd.macd[iLast];
  const macdSigNow = macd.signal[iLast];
  const histNow = macd.histogram[iLast];
  const histPrev = macd.histogram[iLast - 1];
  const bbUpper = ind.last(bb.upper);
  const bbLower = ind.last(bb.lower);
  const bbMid = ind.last(bb.mid);
  const bwNow = ind.last(bb.bandwidth);
  const ema20Now = ind.last(ema20);
  const ema20Prev = ema20[iLast - 5] ?? ema20[iLast - 1];
  const ema50Now = ind.last(ema50);
  const vNow = volumes[iLast];
  const vAvgNow = ind.last(volAvg);
  const vwapNow = ind.last(vwapSeries);
  const vwapPrev = vwapSeries[iLast - 5] ?? vwapSeries[iLast - 1];

  const structure = smc.marketStructure(candles, 2);
  const fvg = smc.fairValueGaps(candles, 60);
  const sweep = smc.liquiditySweep(candles, { span: 2, volAvg: vAvgNow });
  const div = rsiDivergence(candles, rsi14, 2);

  // Bollinger squeeze: current bandwidth near the minimum of the last 40 bars.
  const bwWindow = bb.bandwidth.slice(-40).filter((v) => v != null);
  const bwMin = bwWindow.length ? Math.min(...bwWindow) : null;
  const isSqueeze = bwNow != null && bwMin != null && bwNow <= bwMin * 1.25;

  const signals = [];
  const add = (side, weight, label, kind) => signals.push({ side, weight, label, kind, tf });

  // ---------- SMC (highest priority) ----------
  if (sweep) {
    const w = 3 + Math.min(1.5, sweep.strength);
    add(sweep.type === 'bullish' ? 'up' : 'down', w, `Liquidity sweep ${sweep.type} (respingere${sweep.volSpike ? ' + volum ridicat' : ''})`, 'fast');
  }
  if (fvg.retest) {
    const g = fvg.retest;
    const t = g.effectiveType;
    add(t === 'bullish' ? 'up' : 'down', 2.5 + (g.inverted ? 0.5 : 0), `Retestare ${g.inverted ? 'IFVG' : 'FVG'} ${t}`, 'structural');
  }
  if (structure.mss === 'bullish') add('up', 2.2, 'Market Structure Shift bullish (CHoCH)', 'fast');
  if (structure.mss === 'bearish') add('down', 2.2, 'Market Structure Shift bearish (CHoCH)', 'fast');
  if (structure.trend === 'up') add('up', 1.5, 'Structură de trend ascendent (HH/HL)', 'structural');
  if (structure.trend === 'down') add('down', 1.5, 'Structură de trend descendent (LH/LL)', 'structural');

  // EMA alignment + pullback
  if (ema20Now != null && ema50Now != null) {
    const rising = ema20Prev != null && ema20Now > ema20Prev;
    const falling = ema20Prev != null && ema20Now < ema20Prev;
    if (ema20Now > ema50Now && rising) {
      const nearEma = Math.abs(price - ema20Now) / price < 0.0035;
      add('up', nearEma ? 1.8 : 1.0, `EMA20 > EMA50 în urcare${nearEma ? ' + preț pe suportul dinamic EMA20' : ''}`, 'structural');
    }
    if (ema20Now < ema50Now && falling) {
      const nearEma = Math.abs(price - ema20Now) / price < 0.0035;
      add('down', nearEma ? 1.8 : 1.0, `EMA20 < EMA50 în coborâre${nearEma ? ' + preț la rezistența dinamică EMA20' : ''}`, 'structural');
    }
  }

  // ---------- Oscillators (confirmation) ----------
  if (div.bullish) add('up', 2.0, 'Divergență bullish pe RSI', 'structural');
  if (div.bearish) add('down', 2.0, 'Divergență bearish pe RSI', 'structural');

  if (macdNow != null && macdSigNow != null) {
    const crossUp = macd.macd[iLast - 1] != null && macd.signal[iLast - 1] != null &&
      macd.macd[iLast - 1] <= macd.signal[iLast - 1] && macdNow > macdSigNow;
    const crossDown = macd.macd[iLast - 1] != null && macd.signal[iLast - 1] != null &&
      macd.macd[iLast - 1] >= macd.signal[iLast - 1] && macdNow < macdSigNow;
    if (crossUp) add('up', macdNow < 0 ? 1.6 : 1.1, 'Crossover MACD bullish', 'fast');
    if (crossDown) add('down', macdNow > 0 ? 1.6 : 1.1, 'Crossover MACD bearish', 'fast');
  }
  if (histNow != null && histPrev != null) {
    if (histNow < 0 && histNow > histPrev) add('up', 0.8, 'Histogramă MACD se contractă (momentum descendent slăbește)', 'fast');
    if (histNow > 0 && histNow < histPrev) add('down', 0.8, 'Histogramă MACD se contractă (momentum ascendent slăbește)', 'fast');
  }

  // Bollinger squeeze breakout
  if (isSqueeze && bbUpper != null && price > bbUpper && vAvgNow && vNow > vAvgNow * 1.5) {
    add('up', 2.5, 'Breakout din Bollinger Squeeze cu volum (expansiune)', 'fast');
  }
  if (isSqueeze && bbLower != null && price < bbLower && vAvgNow && vNow > vAvgNow * 1.5) {
    add('down', 2.5, 'Breakdown din Bollinger Squeeze cu volum (expansiune)', 'fast');
  }

  // Bollinger mean-reversion bounce (range) — only with RSI extreme confirmation
  if (bbLower != null && price <= bbLower && rsiNow != null && rsiNow < 32 && structure.trend !== 'down') {
    add('up', 1.4, 'Atingere bandă Bollinger inferioară + RSI supravândut (reversie la medie)', 'fast');
  }
  if (bbUpper != null && price >= bbUpper && rsiNow != null && rsiNow > 68 && structure.trend !== 'up' && div.bearish) {
    add('down', 1.4, 'Atingere bandă Bollinger superioară + RSI supracumpărat + divergență', 'fast');
  }

  // VWAP bias (intraday fair-value anchor)
  if (vwapNow != null) {
    const vwapRising = vwapPrev != null && vwapNow > vwapPrev;
    const vwapFalling = vwapPrev != null && vwapNow < vwapPrev;
    if (price > vwapNow && vwapRising) add('up', 1.0, 'Preț peste VWAP în urcare (bias intraday bullish)', 'structural');
    if (price < vwapNow && vwapFalling) add('down', 1.0, 'Preț sub VWAP în coborâre (bias intraday bearish)', 'structural');
  }

  // Volume absorption (stopping volume) at a low
  if (vAvgNow && vNow > vAvgNow * 1.8) {
    const c = candles[iLast];
    const lowerWick = Math.min(c.close, c.open) - c.low;
    const upperWick = c.high - Math.max(c.close, c.open);
    const body = Math.abs(c.close - c.open);
    if (lowerWick > body && lowerWick > upperWick) add('up', 1.6, 'Volum de oprire / absorbție la minim (wick inferior lung)', 'fast');
    if (upperWick > body && upperWick > lowerWick) add('down', 1.6, 'Volum de distribuție la maxim (wick superior lung)', 'fast');
  }

  const snapshot = {
    price,
    rsi: rsiNow != null ? +rsiNow.toFixed(1) : null,
    macd: macdNow != null ? +macdNow.toFixed(2) : null,
    macdSignal: macdSigNow != null ? +macdSigNow.toFixed(2) : null,
    macdHist: histNow != null ? +histNow.toFixed(2) : null,
    bbUpper: bbUpper != null ? +bbUpper.toFixed(2) : null,
    bbMid: bbMid != null ? +bbMid.toFixed(2) : null,
    bbLower: bbLower != null ? +bbLower.toFixed(2) : null,
    ema20: ema20Now != null ? +ema20Now.toFixed(2) : null,
    ema50: ema50Now != null ? +ema50Now.toFixed(2) : null,
    volume: vNow != null ? +vNow.toFixed(2) : null,
    volAvg: vAvgNow != null ? +vAvgNow.toFixed(2) : null,
    squeeze: isSqueeze,
    vwap: vwapNow != null ? +vwapNow.toFixed(2) : null,
    aboveVwap: vwapNow != null ? price > vwapNow : null,
    trend: structure.trend,
    mss: structure.mss,
    sweep: sweep ? sweep.type : null,
    fvgRetest: fvg.retest ? fvg.retest.effectiveType : null,
    divergence: div.bullish ? 'bullish' : div.bearish ? 'bearish' : null,
  };

  return { signals, snapshot, structure, sweep, fvg };
}

// ---- Combine timeframes into the final verdict ------------------------------
function decide(mtf) {
  // mtf: { '5m': candles, '15m': candles, ... }
  const tf5 = mtf['5m'];
  const tf15 = mtf['15m'];
  const analyses = [];
  if (tf5 && tf5.length >= 60) analyses.push({ tf: '5m', ...analyzeTimeframe(tf5, '5m') });
  if (tf15 && tf15.length >= 60) analyses.push({ tf: '15m', ...analyzeTimeframe(tf15, '15m') });

  const allSignals = analyses.flatMap((a) => a.signals);

  // Higher-timeframe (1h) trend alignment: trade WITH the bigger trend.
  let htfTrend = null;
  const tf60 = mtf['60m'];
  if (tf60 && tf60.length >= 60) {
    const c60 = tf60.map((c) => c.close);
    const e20 = ind.last(ind.ema(c60, 20));
    const e50 = ind.last(ind.ema(c60, 50));
    if (e20 != null && e50 != null) {
      htfTrend = e20 > e50 ? 'up' : 'down';
      allSignals.push({
        side: htfTrend,
        weight: 1.5,
        label: `Aliniere cu trendul 1h (${htfTrend === 'up' ? 'ascendent' : 'descendent'})`,
        kind: 'structural',
        tf: '1h',
      });
    }
  }

  let upScore = 0;
  let downScore = 0;
  let fastWeight = 0;
  let structWeight = 0;
  for (const s of allSignals) {
    if (s.side === 'up') upScore += s.weight;
    else downScore += s.weight;
    if (s.kind === 'fast') fastWeight += s.weight;
    else structWeight += s.weight;
  }

  const net = upScore - downScore;
  const absNet = Math.abs(net);
  let directie = 'NEUTRU';
  if (net > 0.8) directie = 'UP';
  else if (net < -0.8) directie = 'DOWN';

  // Winning-side signals only, sorted by weight.
  const side = directie === 'UP' ? 'up' : directie === 'DOWN' ? 'down' : null;
  const winning = allSignals.filter((s) => s.side === side).sort((a, b) => b.weight - a.weight);
  const confluence = winning.length;

  // ---- QUALITY GATE ----------------------------------------------------------
  // The edge is in genuine TRIGGER events (sweep, squeeze breakout, structure
  // shift, FVG retest, divergence, absorption), NOT in the mere existence of a
  // trend/EMA alignment. On a 10/30-min horizon, "context only" is ~coin-flip.
  // If the winning side has no trigger, we stand down (NEUTRU = no trade).
  const TRIGGER_RE = /sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band/i;
  let noTrigger = false;
  let hasTrigger = false;
  if (directie !== 'NEUTRU') {
    hasTrigger = winning.some((s) => TRIGGER_RE.test(s.label));
    if (!hasTrigger) {
      directie = 'NEUTRU';
      noTrigger = true;
    }
  }

  // Interval: dominated by fast vs structural among winning signals.
  let winFast = 0;
  let winStruct = 0;
  for (const s of winning) {
    if (s.kind === 'fast') winFast += s.weight;
    else winStruct += s.weight;
  }
  const interval = directie === 'NEUTRU' ? '30 minute' : winFast >= winStruct ? '10 minute' : '30 minute';

  // Confidence.
  let incredere = 'Scăzut';
  if (directie !== 'NEUTRU') {
    if (absNet >= 4.5 && confluence >= 3) incredere = 'Ridicat';
    else if (absNet >= 2.5 && confluence >= 2) incredere = 'Mediu';
    else incredere = 'Scăzut';
  }

  // Invalidation level from the strongest structural anchor.
  const primary = analyses[0] || {};
  const price = analyses.length ? analyses[analyses.length - 1].snapshot.price : null;
  let invalidare = 'Structură neclară — fără nivel ferm de invalidare.';
  const anchorTf = tf15 && tf15.length >= 60 ? '15m' : '5m';
  const anchor = analyses.find((a) => a.tf === anchorTf) || analyses[0];
  if (anchor) {
    if (anchor.sweep && directie === 'UP') invalidare = `O închidere sub minimul wick-ului de sweep (~${anchor.sweep.wickExtreme.toFixed(2)}) invalidează scenariul.`;
    else if (anchor.sweep && directie === 'DOWN') invalidare = `O închidere peste maximul wick-ului de sweep (~${anchor.sweep.wickExtreme.toFixed(2)}) invalidează scenariul.`;
    else if (anchor.fvg.retest && directie === 'UP') invalidare = `O închidere fermă sub baza FVG (~${anchor.fvg.retest.bottom.toFixed(2)}) invalidează scenariul.`;
    else if (anchor.fvg.retest && directie === 'DOWN') invalidare = `O închidere fermă peste vârful FVG (~${anchor.fvg.retest.top.toFixed(2)}) invalidează scenariul.`;
    else if (anchor.snapshot.ema20 && directie === 'UP') invalidare = `O închidere de ${anchorTf} sub EMA20 (~${anchor.snapshot.ema20}) semnalează un shift descendent și invalidează scenariul.`;
    else if (anchor.snapshot.ema20 && directie === 'DOWN') invalidare = `O închidere de ${anchorTf} peste EMA20 (~${anchor.snapshot.ema20}) semnalează un shift ascendent și invalidează scenariul.`;
  }

  // Justification text (deterministic; Gemini may rewrite it later).
  let justificare;
  if (directie === 'NEUTRU') {
    justificare = noTrigger
      ? 'Există context direcțional (trend/EMA), dar lipsește un declanșator real (sweep, breakout din squeeze, shift de structură, retestare FVG sau divergență). Fără trigger, mișcarea pe 10/30 min este practic aleatoare — se recomandă așteptarea unui setup clar.'
      : 'Graficul este contradictoriu și lipsit de momentum direcțional clar (structură de tip "chop"). Nu există un dezechilibru major (FVG/sweep) care să impună o direcție cu probabilitate ridicată; se recomandă prudență.';
  } else {
    const top = winning.slice(0, 4).map((s) => `${s.label} (${s.tf})`);
    justificare = `Confluență ${directie} pe ${confluence} semnale. Elemente cheie: ${top.join('; ')}. ` +
      (winFast >= winStruct
        ? 'Setup-ul este de tip momentum acut, deci fereastra scurtă (10 min) captează cel mai bine mișcarea.'
        : 'Setup-ul este structural/așezat, deci se acordă spațiu de desfășurare (30 min).');
  }

  return {
    directie,
    interval,
    justificare,
    incredere,
    invalidare,
    scores: { up: +upScore.toFixed(2), down: +downScore.toFixed(2), net: +net.toFixed(2) },
    confluence,
    signals: winning.map((s) => ({ label: s.label, tf: s.tf, weight: +s.weight.toFixed(2), kind: s.kind })),
    allSignals: allSignals.map((s) => ({ side: s.side, label: s.label, tf: s.tf, weight: +s.weight.toFixed(2) })),
    snapshots: Object.fromEntries(analyses.map((a) => [a.tf, a.snapshot])),
    htfTrend,
    price,
    ts: Date.now(),
  };
}

// ---- Sniper eligibility ----------------------------------------------------
// The A+ recipe validated out-of-sample: a liquidity sweep (ideally
// volume-confirmed) on the signal's direction, during an active session hour.
// This is the ONLY filter that survived out-of-sample testing on ETH.
function sniperEligibility(verdict, hourUTC, activeHours, requireVolume = true) {
  if (!verdict || verdict.directie === 'NEUTRU') {
    return { eligible: false, reason: 'fără direcție clară' };
  }
  const sweep = (verdict.signals || []).find((s) => /liquidity sweep/i.test(s.label));
  if (!sweep) {
    return { eligible: false, reason: 'niciun liquidity sweep pe direcția semnalului' };
  }
  if (requireVolume && !/volum ridicat/i.test(sweep.label)) {
    return { eligible: false, reason: 'sweep fără confirmare de volum' };
  }
  if (Array.isArray(activeHours) && activeHours.length && !activeHours.includes(hourUTC)) {
    return { eligible: false, reason: `în afara orelor active (acum ${hourUTC}:00 UTC)` };
  }
  return { eligible: true, reason: `Sniper A+: ${sweep.label} [${sweep.tf}]` };
}

module.exports = { decide, analyzeTimeframe, rsiDivergence, sniperEligibility };

  });
  define("lib/learning.js", function (module, exports, require) {
'use strict';

// ============================================================================
// learning.js — honest, statistical self-calibration from the user's OWN journal.
// It is NOT a black-box AI. It tracks live win-rate across several context
// dimensions (setup, hour, symbol+direction, order-flow agreement) and, once a
// dimension has enough resolved samples, nudges new signals up or down based on
// how those exact conditions have actually performed for THIS user.
//
// Guards: needs a minimum sample per bucket before it trusts anything, so it
// won't "learn" from noise. It optimizes around the real edge — it does not
// invent one.
// ============================================================================

const DEFAULT_MIN_SAMPLE = 10;

function agg(arr) {
  const n = arr.length;
  const wins = arr.filter((e) => e.win).length;
  return { n, wins, winRate: n ? +((wins / n) * 100).toFixed(1) : null };
}

function bucketize(resolved, keyFn) {
  const map = {};
  for (const e of resolved) {
    const k = keyFn(e);
    if (k == null) continue;
    (map[k] = map[k] || []).push(e);
  }
  const out = {};
  for (const [k, arr] of Object.entries(map)) out[k] = agg(arr);
  return out;
}

// Build all dimension statistics from resolved journal entries.
function analyze(entries) {
  const resolved = entries.filter((e) => e.status === 'resolved');
  return {
    total: resolved.length,
    bySetup: bucketize(resolved, (e) => e.setup || 'necunoscut'),
    byHour: bucketize(resolved, (e) => (e.hourUTC != null ? `h${e.hourUTC}` : null)),
    bySymbolDir: bucketize(resolved, (e) => `${e.symbol}-${e.directie}`),
    byOfAgree: bucketize(resolved, (e) => (e.ofAgree ? `of:${e.ofAgree}` : null)),
    byInterval: bucketize(resolved, (e) => e.interval),
  };
}

// Evaluate a new signal's context against learned stats.
// Returns { estimate, adjustment, ready, factors } where estimate is a blended
// win-rate guess (%) and adjustment is (estimate - 50).
function evaluate(entries, ctx, minSample = DEFAULT_MIN_SAMPLE) {
  const a = analyze(entries);
  const factors = [];
  const pull = (map, key, label) => {
    const o = map[key];
    if (o && o.n >= minSample && o.winRate != null) {
      factors.push({ label, winRate: o.winRate, n: o.n });
    }
  };
  pull(a.bySetup, ctx.setup || 'necunoscut', `setup ${ctx.setup || '—'}`);
  if (ctx.hourUTC != null) pull(a.byHour, `h${ctx.hourUTC}`, `ora ${ctx.hourUTC} UTC`);
  pull(a.bySymbolDir, `${ctx.symbol}-${ctx.directie}`, `${ctx.symbol} ${ctx.directie}`);
  if (ctx.ofAgree) pull(a.byOfAgree, `of:${ctx.ofAgree}`, `order flow ${ctx.ofAgree}`);

  if (!factors.length) {
    return { ready: false, estimate: null, adjustment: 0, factors: [], note: 'încă strâng date — nimic învățat sigur' };
  }
  // Weight each factor by its sample size (more data = more trust).
  let wsum = 0;
  let acc = 0;
  for (const f of factors) {
    const w = Math.min(f.n, 60); // cap influence of any single bucket
    acc += f.winRate * w;
    wsum += w;
  }
  const estimate = +(acc / wsum).toFixed(1);
  const adjustment = +(estimate - 50).toFixed(1);
  return {
    ready: true,
    estimate,
    adjustment,
    factors,
    note: `estimare din istoricul tău: ${estimate}% (din ${factors.length} tipare)`,
  };
}

// Human-readable summary for the UI: best/worst learned buckets.
function summary(entries, minSample = DEFAULT_MIN_SAMPLE) {
  const a = analyze(entries);
  const rows = [];
  const collect = (map, prefix) => {
    for (const [k, o] of Object.entries(map)) {
      if (o.n >= minSample && o.winRate != null) {
        rows.push({ key: `${prefix}: ${k}`, winRate: o.winRate, n: o.n });
      }
    }
  };
  collect(a.bySetup, 'setup');
  collect(a.byHour, 'oră');
  collect(a.bySymbolDir, 'monedă+dir');
  collect(a.byOfAgree, 'order flow');
  collect(a.byInterval, 'fereastră');
  rows.sort((x, y) => y.winRate - x.winRate);
  return {
    total: a.total,
    ready: rows.length > 0,
    best: rows.slice(0, 5),
    worst: rows.slice(-5).reverse(),
    minSample,
  };
}

module.exports = { analyze, evaluate, summary, DEFAULT_MIN_SAMPLE };

  });
  define("lib/gemini.js", function (module, exports, require) {
'use strict';

// ============================================================================
// gemini.js — OPTIONAL narrator / second-opinion layer.
// It is fed the NUMBERS the deterministic engine already computed (never an
// image), and asked to (a) rewrite the justification in natural Romanian and
// (b) give an agreement check. It does NOT decide direction — the engine does.
// If disabled or on any error, the engine's own text is used as fallback.
// ============================================================================

function buildPrompt(symbol, verdict) {
  const snap = JSON.stringify(verdict.snapshots, null, 0);
  const sig = verdict.signals.map((s) => `- ${s.label} [${s.tf}] pondere ${s.weight}`).join('\n');
  return `Ești un analist tehnic crypto sobru și onest. Un motor determinist a analizat ${symbol} pentru un contract event-futures (UP/DOWN pe 10 sau 30 minute) și a produs verdictul de mai jos DEJA. Rolul tău NU este să schimbi direcția, ci să:
1) rescrii "justificare" într-un paragraf clar, natural, în limba română (2-4 propoziții), fără clișee și fără hype;
2) evaluezi dacă ești DE ACORD cu direcția pe baza numerelor (acord: "da"/"partial"/"nu");
3) semnalezi orice risc imediat (ex. RSI extrem, chop, posibil whipsaw).

Verdict motor:
- Direcție: ${verdict.directie}
- Interval: ${verdict.interval}
- Încredere: ${verdict.incredere}
- Scoruri: up=${verdict.scores.up} down=${verdict.scores.down} net=${verdict.scores.net}
- Semnale care susțin direcția:
${sig || '(niciunul)'}
- Snapshot indicatori pe timeframe: ${snap}

Răspunde STRICT în JSON valid, fără text în plus, cu forma:
{"justificare": "...", "acord": "da|partial|nu", "risc": "...", "comentariu": "..."}`;
}

async function narrate(symbol, verdict, cfg) {
  if (!cfg || !cfg.enabled || !cfg.apiKey) {
    return { used: false };
  }
  const model = cfg.model || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: buildPrompt(symbol, verdict) }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 500, responseMimeType: 'application/json' },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { used: false, error: `HTTP ${res.status} ${t.slice(0, 150)}` };
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed) return { used: false, error: 'unparseable AI response' };
    return { used: true, ...parsed };
  } catch (e) {
    return { used: false, error: String(e.message || e) };
  }
}

// Quick key test used by the UI "Test AI key" button.
async function testKey(cfg) {
  if (!cfg || !cfg.apiKey) return { ok: false, error: 'no key' };
  const model = cfg.model || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Raspunde cu un singur cuvant: ok' }] }] }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 150)}` };
    }
    return { ok: true, model };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { narrate, testKey, buildPrompt };

  });
  global.SignalPilotCore = Object.freeze({
    engine: load('lib/engine.js'),
    learning: load('lib/learning.js'),
    gemini: load('lib/gemini.js'),
  });
})(window);
