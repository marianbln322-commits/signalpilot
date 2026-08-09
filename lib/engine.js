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

// ---- Trigger taxonomy (SINGLE SOURCE OF TRUTH) -----------------------------
// Previously this classification lived as three separate copies of a regex in
// engine.js, server.js and backtest.js. They drifted, which meant the live app,
// the journal and the backtest could each disagree about what "the setup" was.
//
// Each entry also declares the contract window the setup naturally belongs to:
//   10 minute -> impulsive, single-bar rejection/expansion events
//   30 minute -> structural setups that need room to play out
//
// This replaces the old horizon rule, which compared the SUMMED weight of all
// "fast" signals against all "structural" signals. Because context signals
// (trend, EMA alignment, VWAP, 1h alignment) are present on almost every bar
// while true triggers are rare, structural weight nearly always won: measured on
// 4000 bars, only 2.4% of signals came out as 10-minute. The window is now taken
// from the PRIMARY trigger, so both windows genuinely occur.
const TRIGGERS = [
  { re: /liquidity sweep/i,                  setup: 'Liquidity Sweep',        horizon: '10 minute' },
  { re: /squeeze/i,                          setup: 'Squeeze breakout',       horizon: '10 minute' },
  { re: /absorb|distribuție|oprire/i,        setup: 'Volume absorption',      horizon: '10 minute' },
  { re: /bandă bollinger|reversie la medie/i, setup: 'Bollinger bounce',      horizon: '10 minute' },
  { re: /crossover/i,                        setup: 'MACD crossover',         horizon: '10 minute' },
  { re: /market structure shift/i,           setup: 'Market Structure Shift', horizon: '30 minute' },
  { re: /ifvg/i,                             setup: 'Inversion FVG',          horizon: '30 minute' },
  { re: /fvg/i,                              setup: 'FVG retest',             horizon: '30 minute' },
  { re: /divergen/i,                         setup: 'RSI divergence',         horizon: '30 minute' },
];

// Classify a signal label into { setup, horizon }, or null if it is mere context.
function classifyTrigger(label) {
  if (!label) return null;
  for (const t of TRIGGERS) {
    if (t.re.test(label)) return { setup: t.setup, horizon: t.horizon };
  }
  return null;
}

const isTrigger = (label) => classifyTrigger(label) !== null;

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
  const atrSeries = ind.atr(highs, lows, closes, 14) || [];

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

  const atrNow = ind.last(atrSeries);
  const structure = smc.marketStructure(candles, 2);
  // ATR is passed so the FVG detector can require genuine displacement instead
  // of matching every trivial 3-bar imbalance.
  const fvg = smc.fairValueGaps(candles, 60, { atr: atrNow });
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
    atr: atrNow != null ? +atrNow.toFixed(2) : null,
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
  let noTrigger = false;
  // The highest-weight genuine trigger on the winning side defines the setup.
  let primaryTrigger = null;
  if (directie !== 'NEUTRU') {
    primaryTrigger = winning.find((s) => isTrigger(s.label)) || null;
    if (!primaryTrigger) {
      directie = 'NEUTRU';
      noTrigger = true;
    }
  }

  // Interval comes from the PRIMARY TRIGGER's natural window (see TRIGGERS).
  const triggerInfo = primaryTrigger ? classifyTrigger(primaryTrigger.label) : null;
  const setup = triggerInfo ? triggerInfo.setup : 'context';
  const interval = triggerInfo ? triggerInfo.horizon : '30 minute';

  // Kept for display/diagnostics only — no longer decides the window.
  let winFast = 0;
  let winStruct = 0;
  for (const s of winning) {
    if (s.kind === 'fast') winFast += s.weight;
    else winStruct += s.weight;
  }

  // Confidence.
  let incredere = 'Scăzut';
  if (directie !== 'NEUTRU') {
    if (absNet >= 4.5 && confluence >= 3) incredere = 'Ridicat';
    else if (absNet >= 2.5 && confluence >= 2) incredere = 'Mediu';
    else incredere = 'Scăzut';
  }

  // Invalidation level from the strongest structural anchor.
  const primary = analyses[0] || {};
  // Take the price from the FINEST timeframe available, not from whichever analysis
  // happened to be pushed last. Analyses are appended 5m then 15m, so
  // `analyses[analyses.length - 1]` was the 15-minute view: since the engine only
  // sees closed candles, that close could be a quarter of an hour old, and it was
  // what the UI displayed as the current price.
  //
  // This is still a CLOSED-candle price. It is the right anchor for structure and
  // for invalidation levels, but it is not the live market price — the server
  // overrides it for display and journalling from the price tape.
  const fine = analyses.find((a) => a.tf === '5m') || analyses[0];
  const price = fine ? fine.snapshot.price : null;
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
    justificare = `Declanșator principal: ${primaryTrigger.label} [${primaryTrigger.tf}]. ` +
      `Confluență ${directie} pe ${confluence} semnale: ${top.join('; ')}. ` +
      (interval === '10 minute'
        ? 'Este un eveniment impulsiv de o singură lumânare, deci fereastra scurtă (10 min) captează cel mai bine mișcarea.'
        : 'Este un setup structural, deci are nevoie de spațiu de desfășurare (30 min).');
  }

  // Identity of the bar this verdict was computed from. Because the engine now
  // only ever sees CLOSED candles, (symbol, barCloseTime) uniquely identifies a
  // verdict — which lets the server emit exactly one alert per bar instead of
  // re-evaluating the same bar on every poll.
  const fastest = tf5 && tf5.length ? tf5 : tf15;
  const lastBar = fastest && fastest.length ? fastest[fastest.length - 1] : null;

  return {
    directie,
    interval,
    justificare,
    incredere,
    invalidare,
    setup,
    primaryTrigger: primaryTrigger
      ? { label: primaryTrigger.label, tf: primaryTrigger.tf, weight: +primaryTrigger.weight.toFixed(2) }
      : null,
    score: +absNet.toFixed(2),
    scores: { up: +upScore.toFixed(2), down: +downScore.toFixed(2), net: +net.toFixed(2) },
    confluence,
    weightSplit: { fast: +winFast.toFixed(2), structural: +winStruct.toFixed(2) },
    signals: winning.map((s) => ({ label: s.label, tf: s.tf, weight: +s.weight.toFixed(2), kind: s.kind })),
    allSignals: allSignals.map((s) => ({ side: s.side, label: s.label, tf: s.tf, weight: +s.weight.toFixed(2) })),
    snapshots: Object.fromEntries(analyses.map((a) => [a.tf, a.snapshot])),
    htfTrend,
    price,
    barOpenTime: lastBar ? lastBar.openTime : null,
    barCloseTime: lastBar ? lastBar.closeTime : null,
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

module.exports = {
  decide,
  analyzeTimeframe,
  rsiDivergence,
  sniperEligibility,
  classifyTrigger,
  isTrigger,
  TRIGGERS,
};
