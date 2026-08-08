'use strict';

// ============================================================================
// backtest.js — honest, walk-forward evaluation of the engine.
//
// Three defects in the previous version made its numbers unusable:
//
// 1. NO PARITY WITH LIVE. It called engine.decide({'5m','15m'}) while the server
//    calls engine.decide({'5m','15m','60m'}). The 1h trend-alignment signal
//    (weight 1.5) therefore existed live but not in validation, so the two could
//    return different verdicts from the same data — verified: one returned
//    NEUTRU where the other returned UP. Whatever win-rate it printed described
//    a strategy nobody was running. It now feeds the exact same timeframes.
//
// 2. NO TRAIN/TEST SEPARATION. Win-rate was reported over the whole sample, then
//    the best-looking subset ("sweep + volume + active hours") was picked from
//    those same numbers. That is selecting a hypothesis on the data you then
//    quote as evidence for it. Calibration is now fitted on an EARLIER slice and
//    scored only on a LATER, untouched slice.
//
// 3. NO NULL BASELINE AND NO ERROR BARS. "54.8%" means nothing without knowing
//    what a coin flip scored on the same bars and how wide the interval is. Both
//    are now reported, plus a binomial test against 50%.
//
// Overlap: signals are spaced by at least the longest horizon so samples do not
// share outcome bars. Overlapping samples are correlated and would make the
// significance test look far stronger than it is.
// ============================================================================

const binance = require('./binance');
const engine = require('./engine');
const cal = require('./calibration');
const candles = require('./candles');

const WINDOW = 200;         // candles fed to the engine
const HORIZON_10 = 2;       // 2 x 5m = 10 min
const HORIZON_30 = 6;       // 6 x 5m = 30 min
const COOLDOWN = HORIZON_30; // non-overlapping samples

async function run(symbol, opts = {}) {
  const days = Math.min(60, Math.max(3, opts.days || 15));
  const endDaysAgo = Math.max(0, opts.endDaysAgo || 0);
  const trainFraction = Math.min(0.9, Math.max(0.3, opts.trainFraction || 0.6));
  const payout10 = opts.payout10 != null ? Number(opts.payout10) : 65;
  const payout30 = opts.payout30 != null ? Number(opts.payout30) : 82;
  const endTimeMs = endDaysAgo > 0 ? Date.now() - endDaysAgo * 86400 * 1000 : null;

  // PARITY: fetch every timeframe the live server uses, including 1h.
  const tf5 = await binance.fetchHistory(symbol, '5m', days, 1000, endTimeMs);
  const tf15 = await binance.fetchHistory(symbol, '15m', days, 1000, endTimeMs);
  const tf60 = await binance.fetchHistory(symbol, '1h', days, 1000, endTimeMs);

  if (tf5.length < WINDOW + HORIZON_30 + 10) {
    throw new Error(`istoric insuficient pentru ${symbol}: ${tf5.length} lumânări de 5m`);
  }

  const samples = [];
  let lastIdx = -Infinity;
  let neutralCount = 0;

  for (let i = WINDOW; i < tf5.length - HORIZON_30; i++) {
    const asOf = tf5[i].closeTime;
    const w5 = tf5.slice(i - WINDOW, i + 1);
    const w15 = candles.upTo(tf15, asOf).slice(-WINDOW);
    const w60 = candles.upTo(tf60, asOf).slice(-WINDOW);
    if (w15.length < 60) continue;

    const mtf = { '5m': w5, '15m': w15 };
    if (w60.length >= 60) mtf['60m'] = w60;

    let verdict;
    try {
      verdict = engine.decide(mtf);
    } catch {
      continue;
    }
    if (verdict.directie === 'NEUTRU') { neutralCount++; continue; }
    if (i - lastIdx < COOLDOWN) continue;
    lastIdx = i;

    const entry = tf5[i].close;
    const exit10 = tf5[i + HORIZON_10].close;
    const exit30 = tf5[i + HORIZON_30].close;
    const up = verdict.directie === 'UP';
    const win10 = up ? exit10 > entry : exit10 < entry;
    const win30 = up ? exit30 > entry : exit30 < entry;
    const natural = verdict.interval;

    samples.push({
      ts: tf5[i].openTime,
      time: new Date(tf5[i].openTime).toISOString(),
      hour: new Date(tf5[i].openTime).getUTCHours(),
      setup: verdict.setup,
      interval: natural,
      direction: verdict.directie,
      score: verdict.score,
      confidence: verdict.incredere,
      entry: +entry.toFixed(2),
      exit10: +exit10.toFixed(2),
      exit30: +exit30.toFixed(2),
      win10,
      win30,
      // Outcome at the window the engine actually chose.
      win: natural === '10 minute' ? win10 : win30,
      // Null baselines measured on the SAME bars.
      baselineUp10: exit10 > entry,
      baselineUp30: exit30 > entry,
    });
  }

  if (samples.length < 20) {
    return {
      symbol,
      days,
      source: 'binance.vision (proxy pentru istoric adânc)',
      totalCandles: tf5.length,
      neutralCount,
      evaluated: samples.length,
      error: `prea puține semnale (${samples.length}) pentru o concluzie. Mărește perioada.`,
    };
  }

  // ---- Time-ordered train/test split ---------------------------------------
  samples.sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(samples.length * trainFraction);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);

  // Fit calibration on TRAIN ONLY.
  const model = cal.fit(train, { minSample: opts.minSample || 30 });

  // Score the untouched TEST slice.
  const scored = test.map((s) => {
    const pred = cal.predict(model, { setup: s.setup, interval: s.interval, score: s.score });
    const payout = s.interval === '10 minute' ? payout10 : payout30;
    const gate = cal.decide(pred, payout, { marginPct: opts.marginPct });
    return { ...s, probability: pred.probability, predReady: pred.ready, gate };
  });

  const rate = (rows, field = 'win') => {
    const n = rows.length;
    const wins = rows.filter((r) => r[field]).length;
    const ci = cal.wilson(wins, n);
    const sig = cal.vsCoinFlip(wins, n);
    return {
      n,
      wins,
      winRate: n ? +((wins / n) * 100).toFixed(2) : null,
      ci95: n ? [ci.low, ci.high] : null,
      vsCoinFlip: sig,
    };
  };

  const byGroup = (rows, keyFn, field = 'win') => {
    const map = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    const out = {};
    for (const [k, v] of [...map.entries()].sort()) out[k] = rate(v, field);
    return out;
  };

  // Only the signals the EV gate would actually have approved.
  const approved = scored.filter((s) => s.gate.trade);

  // Baseline: what did "always bet UP" score on the very same test bars?
  const baseUp = rate(
    test.map((s) => ({ win: s.interval === '10 minute' ? s.baselineUp10 : s.baselineUp30 }))
  );
  const baseDown = rate(
    test.map((s) => ({ win: !(s.interval === '10 minute' ? s.baselineUp10 : s.baselineUp30) }))
  );

  return {
    symbol,
    source: 'binance.vision (proxy pentru istoric adânc)',
    parity: 'engine primește 5m+15m+60m, identic cu serverul live',
    days,
    totalCandles: tf5.length,
    neutralCount,
    evaluated: samples.length,
    cooldownBars: COOLDOWN,
    split: { trainFraction, trainN: train.length, testN: test.length },

    // ---- headline: out-of-sample only ----
    outOfSample: {
      all: rate(test),
      byInterval: byGroup(test, (s) => s.interval),
      bySetup: byGroup(test, (s) => s.setup),
      byDirection: byGroup(test, (s) => s.direction),
      byHour: byGroup(test, (s) => `h${String(s.hour).padStart(2, '0')}`),
    },

    // ---- does the horizon choice matter? both windows, same signals ----
    horizonComparison: {
      note: 'aceleași semnale evaluate la 10 vs 30 min, ca să se vadă care fereastră e mai bună per setup',
      at10: rate(test, 'win10'),
      at30: rate(test, 'win30'),
      bySetupAt10: byGroup(test, (s) => s.setup, 'win10'),
      bySetupAt30: byGroup(test, (s) => s.setup, 'win30'),
    },

    // ---- null baselines on the identical bars ----
    baselines: {
      note: 'dacă motorul nu bate clar aceste linii, nu are edge',
      alwaysUp: baseUp,
      alwaysDown: baseDown,
      coinFlip: 50,
    },

    // ---- probability quality ----
    calibration: {
      fittedOn: train.length,
      minSample: model.minSample,
      brierScore: cal.brierScore(scored),
      brierBaseline: 0.25,
      brierNote: '0.25 = ce obții spunând mereu 50%. Mai mic e mai bun.',
      reliability: cal.reliability(scored),
      coverage: {
        withProbability: scored.filter((s) => s.predReady).length,
        withoutProbability: scored.filter((s) => !s.predReady).length,
      },
    },

    // ---- the only number that matters for real money ----
    evGate: {
      note: 'doar semnalele pe care poarta EV le-ar fi aprobat (limita inferioară a intervalului de încredere peste pragul impus de payout)',
      payout10,
      payout30,
      breakEven10: cal.breakEvenWinRate(payout10),
      breakEven30: cal.breakEvenWinRate(payout30),
      approvedCount: approved.length,
      rejectedCount: scored.length - approved.length,
      approved: rate(approved),
      approvedByInterval: byGroup(approved, (s) => s.interval),
      realizedEv10: approved.filter((s) => s.interval === '10 minute').length
        ? cal.expectedValue(rate(approved.filter((s) => s.interval === '10 minute')).winRate, payout10)
        : null,
      realizedEv30: approved.filter((s) => s.interval === '30 minute').length
        ? cal.expectedValue(rate(approved.filter((s) => s.interval === '30 minute')).winRate, payout30)
        : null,
    },

    model,
    trades: scored.slice(0, 200).map((s) => ({
      time: s.time,
      directie: s.direction,
      interval: s.interval,
      setup: s.setup,
      score: s.score,
      probability: s.probability,
      approved: s.gate.trade,
      entry: s.entry,
      exit: s.interval === '10 minute' ? s.exit10 : s.exit30,
      win: s.win,
    })),
  };
}

module.exports = { run, WINDOW, HORIZON_10, HORIZON_30, COOLDOWN };
