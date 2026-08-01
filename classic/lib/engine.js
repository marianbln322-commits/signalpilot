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
