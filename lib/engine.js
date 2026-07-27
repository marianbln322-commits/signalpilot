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

// Build an explicit directional forecast for one Event Futures horizon.
// 10m reads 1m/5m/15m; 30m reads 5m/15m/30m. Technical confluence is exposed
// only as a score, never as a financial probability. A forecast remains WAIT
// until resolved forward observations calibrate its success probability.
function forecastHorizon(mtf, horizon) {
  const definitions = horizon === 10
    ? [{ tf: '1m', mult: 0.8 }, { tf: '5m', mult: 1.25 }, { tf: '15m', mult: 0.85 }]
    : [{ tf: '5m', mult: 0.7 }, { tf: '15m', mult: 1.2 }, { tf: '30m', mult: 1.3 }];
  const analyses = definitions
    .filter(({ tf }) => mtf[tf] && mtf[tf].length >= 60)
    .map(({ tf, mult }) => ({ tf, mult, ...analyzeTimeframe(mtf[tf], tf) }));

  if (analyses.length !== definitions.length) {
    return {
      horizon,
      directie: 'NEUTRU',
      action: 'WAIT',
      calibrated: false,
      probabilityUp: null,
      probabilityDown: null,
      confidence: null,
      technicalScoreUp: 0.5,
      technicalScoreDown: 0.5,
      technicalConfidence: 0.5,
      setupValid: false,
      timeframes: definitions.map((d) => d.tf),
      reasons: ['Date insuficiente pe unul sau mai multe intervale relevante.'],
      scores: { up: 0, down: 0, net: 0 },
    };
  }

  let up = 0;
  let down = 0;
  const timeframeVotes = [];
  const weightedSignals = [];
  for (const analysis of analyses) {
    let localUp = 0;
    let localDown = 0;
    for (const signal of analysis.signals) {
      const weighted = signal.weight * analysis.mult;
      if (signal.side === 'up') localUp += weighted;
      else localDown += weighted;
      weightedSignals.push({ ...signal, weight: weighted });
    }
    up += localUp;
    down += localDown;
    const delta = localUp - localDown;
    timeframeVotes.push({
      tf: analysis.tf,
      side: Math.abs(delta) < 0.05 ? 'NEUTRU' : delta > 0 ? 'UP' : 'DOWN',
      net: delta,
    });
  }

  // Establish direction from the horizon's declared inputs before considering
  // 60m context. Higher timeframe may reinforce that direction, never create it.
  const relevantNet = up - down;
  const relevantDirection = Math.abs(relevantNet) < 0.25 ? 'NEUTRU' : relevantNet > 0 ? 'UP' : 'DOWN';

  const tf60 = mtf['60m'];
  let htfTrend = null;
  if (tf60 && tf60.length >= 60) {
    const closes = tf60.map((c) => c.close);
    const e20 = ind.last(ind.ema(closes, 20));
    const e50 = ind.last(ind.ema(closes, 50));
    if (e20 != null && e50 != null) {
      const relativeGap = Math.abs(e20 - e50) / Math.max(Math.abs(e50), 1e-9);
      if (relativeGap >= 0.0001) {
        htfTrend = e20 > e50 ? 'UP' : 'DOWN';
        if (htfTrend === relevantDirection) {
          if (htfTrend === 'UP') up += 0.75;
          else down += 0.75;
        }
      }
    }
  }

  const net = up - down;
  const directie = relevantDirection;
  const evidence = Math.min(1, weightedSignals.length / 7);
  const rawTechnicalScoreUp = 1 / (1 + Math.exp(-net / 3.2));
  // This bounded value ranks technical confluence only. It is intentionally not
  // named or treated as probability because it has no empirical calibration.
  const technicalScoreUp = directie === 'NEUTRU' ? 0.5 : Math.max(0.25, Math.min(0.75,
    0.5 + (rawTechnicalScoreUp - 0.5) * (0.55 + evidence * 0.45)
  ));
  const technicalScoreDown = 1 - technicalScoreUp;
  const technicalConfidence = Math.max(technicalScoreUp, technicalScoreDown);
  const agreeing = directie === 'NEUTRU'
    ? 0
    : timeframeVotes.filter((vote) => vote.side === directie).length;
  const winning = directie === 'NEUTRU' ? [] : weightedSignals
    .filter((signal) => signal.side === directie.toLowerCase())
    .sort((a, b) => b.weight - a.weight);
  const triggerPattern = /sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band/i;
  const hasTrigger = winning.some((signal) => triggerPattern.test(signal.label));
  const setupValid = directie !== 'NEUTRU' && technicalConfidence >= 0.58 && agreeing >= 2 && hasTrigger;
  const reasons = winning.slice(0, 4).map((signal) => `${signal.label} [${signal.tf}]`);
  if (htfTrend) reasons.push(`Trend contextual 1h: ${htfTrend}`);
  if (!hasTrigger) reasons.push('Lipsește un trigger tehnic puternic; se păstrează WAIT.');
  if (agreeing < 2) reasons.push('Intervalele relevante nu sunt suficient aliniate.');
  if (setupValid) reasons.push('Setup tehnic valid; se așteaptă calibrarea statistică înainte de TRADE.');

  return {
    horizon,
    directie,
    action: 'WAIT',
    calibrated: false,
    probabilityUp: null,
    probabilityDown: null,
    confidence: null,
    technicalScoreUp: +technicalScoreUp.toFixed(4),
    technicalScoreDown: +technicalScoreDown.toFixed(4),
    technicalConfidence: +technicalConfidence.toFixed(4),
    setupValid,
    timeframes: definitions.map((definition) => definition.tf),
    timeframeVotes,
    reasons,
    htfTrend,
    scores: { up: +up.toFixed(2), down: +down.toFixed(2), net: +net.toFixed(2) },
  };
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

  const forecasts = {
    10: forecastHorizon(mtf, 10),
    30: forecastHorizon(mtf, 30),
  };

  return {
    directie,
    interval,
    justificare,
    incredere,
    invalidare,
    forecasts,
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

module.exports = { decide, analyzeTimeframe, forecastHorizon, rsiDivergence, sniperEligibility };
