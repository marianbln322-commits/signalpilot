'use strict';

// ============================================================================
// features.js — turns closed candles into a numeric feature vector.
//
// WHY THIS FILE EXISTS
// The engine scored setups with weights chosen by hand:
//
//     if (sweep)                     w = 3 + Math.min(1.5, sweep.strength);
//     if (structure.mss === 'bullish') add('up', 2.2, ...);
//     if (structure.trend === 'up')    add('up', 1.5, ...);
//
// Nothing ever checked whether a sweep deserves 3.0 and a trend 1.5, or whether
// the ordering should be reversed, or whether either matters at all. Those are
// empirical questions and they were answered by assertion. That is the
// difference between applying rules from a book and having actually traded: an
// operator with a million fills has those weights calibrated by outcomes.
//
// This module produces the inputs; model.js learns the weights from labelled
// outcomes. Two rules are enforced here:
//
//   1. NO LOOK-AHEAD. Features at bar i use bars <= i only, and bar i must be
//      closed. The label comes from bar i+H, which the feature code never sees.
//   2. SCALE-FREE. Everything is normalised — by ATR, by price, or as a ratio —
//      so a model fitted while BTC traded at 64k still applies at 90k, and ETH
//      and BTC features live on the same scale.
// ============================================================================

const ind = require('./indicators');
const smc = require('./smc');

const safe = (v, d = 0) => (Number.isFinite(v) ? v : d);
const div = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b) > 1e-12 ? a / b : 0);
// Squash unbounded ratios so a single outlier bar cannot dominate a linear model.
const clip = (v, lo = -6, hi = 6) => Math.max(lo, Math.min(hi, safe(v)));

// ---- Features for ONE timeframe --------------------------------------------
function timeframeFeatures(candles, tf) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume);
  const i = n - 1;
  const price = closes[i];

  const atrSeries = ind.atr(highs, lows, closes, 14) || [];
  const atr = safe(ind.last(atrSeries), price * 0.001) || price * 0.001;
  const rsi = ind.rsi(closes, 14) || [];
  const macd = ind.macd(closes) || { macd: [], signal: [], histogram: [] };
  const bb = ind.bollinger(closes, 20, 2) || { upper: [], mid: [], lower: [], bandwidth: [] };
  const ema20 = ind.ema(closes, 20) || [];
  const ema50 = ind.ema(closes, 50) || [];
  const volAvg = ind.volumeAverage(vols, 20) || [];
  const vwap = ind.vwap(candles, 96) || [];

  const f = {};
  const put = (k, v) => { f[`${tf}_${k}`] = clip(v); };

  // Momentum over several lookbacks, in ATR units. ATR normalisation is what
  // makes a 10-bar move comparable across regimes.
  for (const k of [1, 2, 3, 5, 10, 20]) {
    if (i - k >= 0) put(`ret${k}`, div(price - closes[i - k], atr));
  }

  // Oscillators, centred so 0 means neutral.
  const r = ind.last(rsi);
  put('rsi', div(safe(r, 50) - 50, 50));
  if (rsi[i - 3] != null) put('rsi_d3', div(safe(r, 50) - rsi[i - 3], 50));

  const hist = macd.histogram[i];
  put('macd_hist', div(safe(hist), atr));
  if (macd.histogram[i - 1] != null) put('macd_hist_d', div(safe(hist) - macd.histogram[i - 1], atr));
  put('macd_above', safe(macd.macd[i]) > safe(macd.signal[i]) ? 1 : -1);

  // Position inside the Bollinger envelope, and how compressed it is.
  const up = ind.last(bb.upper); const mid = ind.last(bb.mid); const lo = ind.last(bb.lower);
  if (up != null && mid != null) put('bb_pos', div(price - mid, up - mid));
  const bw = bb.bandwidth.slice(-60).filter((v) => v != null);
  if (bw.length > 10) {
    const med = [...bw].sort((a, b) => a - b)[Math.floor(bw.length / 2)];
    put('bb_squeeze', div(ind.last(bb.bandwidth), med) - 1);
  }

  // Trend geometry.
  const e20 = ind.last(ema20); const e50 = ind.last(ema50);
  if (e20 != null && e50 != null) put('ema_spread', div(e20 - e50, atr));
  if (e20 != null) put('ema20_dist', div(price - e20, atr));
  if (e20 != null && ema20[i - 5] != null) put('ema20_slope', div(e20 - ema20[i - 5], atr));
  const vw = ind.last(vwap);
  if (vw != null) put('vwap_dist', div(price - vw, atr));

  // Volume and candle shape — where absorption/exhaustion would show up.
  const vAvg = ind.last(volAvg);
  put('vol_ratio', Math.log(Math.max(1e-9, div(vols[i], vAvg) || 1)));
  const c = candles[i];
  const range = Math.max(1e-12, c.high - c.low);
  put('body', div(c.close - c.open, range));
  put('upper_wick', div(c.high - Math.max(c.open, c.close), range));
  put('lower_wick', div(Math.min(c.open, c.close) - c.low, range));
  put('range_atr', div(range, atr));

  // Volatility regime: is the recent past faster or slower than the near past?
  const rv = (k) => {
    if (i - k < 1) return null;
    let s = 0;
    for (let j = i - k + 1; j <= i; j++) s += ((closes[j] - closes[j - 1]) / closes[j - 1]) ** 2;
    return Math.sqrt(s / k);
  };
  const v5 = rv(5); const v30 = rv(30);
  if (v5 != null && v30 != null) put('vol_regime', div(v5, v30) - 1);

  // Distance to the levels price is actually reacting to.
  const sw = smc.swings(candles, 2);
  const lastHi = sw.highs.length ? sw.highs[sw.highs.length - 1].price : null;
  const lastLo = sw.lows.length ? sw.lows[sw.lows.length - 1].price : null;
  if (lastHi != null) put('dist_swing_high', div(price - lastHi, atr));
  if (lastLo != null) put('dist_swing_low', div(price - lastLo, atr));

  // The SMC events the old engine hand-weighted. Kept as inputs — but now the
  // weight, and the sign, are decided by the data.
  const st = smc.marketStructure(candles, 2);
  put('trend_up', st.trend === 'up' ? 1 : st.trend === 'down' ? -1 : 0);
  put('mss', st.mss === 'bullish' ? 1 : st.mss === 'bearish' ? -1 : 0);

  const sweep = smc.liquiditySweep(candles, { span: 2, volAvg: vAvg });
  put('sweep', sweep ? (sweep.type === 'bullish' ? 1 : -1) : 0);
  put('sweep_strength', sweep ? (sweep.type === 'bullish' ? 1 : -1) * safe(sweep.strength) : 0);
  put('sweep_vol', sweep && sweep.volSpike ? (sweep.type === 'bullish' ? 1 : -1) : 0);

  const fvg = smc.fairValueGaps(candles, 60);
  const rt = fvg && fvg.retest;
  put('fvg_retest', rt ? (rt.effectiveType === 'bullish' ? 1 : -1) : 0);

  return f;
}

// ---- Full vector across timeframes -----------------------------------------
//
// `mtf` must contain CLOSED candles only. The caller is responsible for that;
// lib/candles.js exists for exactly this reason.
function extract(mtf, opts = {}) {
  const tfs = opts.timeframes || ['5m', '15m', '60m'];
  const out = {};
  for (const tf of tfs) {
    const c = mtf[tf];
    if (!Array.isArray(c) || c.length < 60) return null; // not enough context
    Object.assign(out, timeframeFeatures(c, tf));
  }

  // Cross-timeframe agreement: the old engine asserted that alignment matters
  // and gave it weight 1.5. Here it is a feature like any other.
  const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  out.align_5_15 = sgn(out['5m_ret5']) * sgn(out['15m_ret5']);
  out.align_15_60 = sgn(out['15m_ret5']) * sgn(out['60m_ret5']);
  out.align_all = sgn(out['5m_ret5']) + sgn(out['15m_ret5']) + sgn(out['60m_ret5']);

  // Session effects, encoded cyclically so 23:00 and 00:00 are adjacent rather
  // than maximally distant. 21 separate hour buckets is how you manufacture
  // fake edge; two smooth coordinates is how you let the model find a real one.
  const t = mtf['5m'][mtf['5m'].length - 1].openTime;
  const d = new Date(t);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  out.hour_sin = Math.sin((2 * Math.PI * hour) / 24);
  out.hour_cos = Math.cos((2 * Math.PI * hour) / 24);
  out.dow_sin = Math.sin((2 * Math.PI * d.getUTCDay()) / 7);
  out.dow_cos = Math.cos((2 * Math.PI * d.getUTCDay()) / 7);

  return out;
}

// Stable ordering, so a saved model always lines up with fresh features.
function featureNames(sample) {
  return Object.keys(sample).sort();
}
function vectorize(sample, names) {
  return names.map((k) => clip(safe(sample[k])));
}

module.exports = { extract, timeframeFeatures, featureNames, vectorize };
