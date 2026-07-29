'use strict';

// ============================================================================
// candles.js — candle hygiene. This module exists to kill ONE specific class of
// bug: acting on the candle that is still forming.
//
// WHY THIS MATTERS
// MEXC/Binance kline endpoints return the in-progress candle as the last row.
// Its high/low/close/volume keep changing until the bar closes. Any detector
// that reads that row (sweeps, volume spikes, wick ratios, RSI, MACD...) will
// produce a verdict that mutates during the bar — the classic "repainting"
// problem. The live app then flips UP/DOWN mid-bar, while the backtest — which
// replays only completed bars — never sees those flips. Backtest and live stop
// describing the same strategy, so the measured win-rate is meaningless.
//
// The rule enforced here: decisions are computed ONLY from confirmed, closed
// candles. The forming candle is still useful for displaying the current price,
// but it never feeds a detector.
// ============================================================================

// Is this candle definitively closed?
// A candle is closed once wall-clock time has passed its closeTime.
function isClosed(candle, now = Date.now()) {
  if (!candle) return false;
  if (Number.isFinite(candle.closeTime) && candle.closeTime > 0) return now > candle.closeTime;
  return false; // unknown closeTime -> treat as unconfirmed (fail safe)
}

// Drop any trailing candles that have not closed yet.
// Returns a NEW array; never mutates the input.
function closedOnly(candles, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  let end = candles.length;
  while (end > 0 && !isClosed(candles[end - 1], now)) end--;
  return candles.slice(0, end);
}

// Split a series into { closed, forming }.
// `forming` is the in-progress candle (or null) — display only.
function split(candles, now = Date.now()) {
  const closed = closedOnly(candles, now);
  const forming = closed.length < candles.length ? candles[candles.length - 1] : null;
  return { closed, forming };
}

// Aggregate k consecutive candles into one higher-timeframe candle.
// Only emits COMPLETE groups, so the tail is never a partial bar.
// Used to derive 15m/60m views from a 5m series with guaranteed alignment.
function aggregate(candles, k) {
  const out = [];
  if (!Array.isArray(candles) || k < 1) return out;
  for (let i = 0; i + k <= candles.length; i += k) {
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (let j = i; j < i + k; j++) {
      if (candles[j].high > high) high = candles[j].high;
      if (candles[j].low < low) low = candles[j].low;
      volume += candles[j].volume;
    }
    out.push({
      openTime: candles[i].openTime,
      open: candles[i].open,
      high,
      low,
      close: candles[i + k - 1].close,
      volume,
      closeTime: candles[i + k - 1].closeTime,
    });
  }
  return out;
}

// Keep only candles that had already closed at or before `asOf`.
// This is the core no-look-ahead primitive for the backtest: it reconstructs
// exactly the information set available at decision time.
function upTo(candles, asOf) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((c) => c.closeTime <= asOf);
}

module.exports = { isClosed, closedOnly, split, aggregate, upTo };
