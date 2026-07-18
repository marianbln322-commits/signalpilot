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
