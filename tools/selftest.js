'use strict';

// ============================================================================
// selftest.js — offline verification. Requires no network and no API keys.
//
//   node tools/selftest.js
//
// These are not unit tests of arithmetic; they are guards against the specific
// failure modes that made this app's output untrustworthy:
//
//   1. Repainting      — does a verdict change while a candle is still forming?
//   2. Horizon balance — do 10-minute signals actually occur?
//   3. Determinism     — same closed bars in, same verdict out?
//   4. Null edge       — on pure noise, does the EV gate correctly refuse?
//   5. Event maths     — break-even, EV and interval arithmetic.
//
// Test 4 is the important one. Any signal engine can be made to fire; the thing
// that protects money is refusing to fire when there is nothing there.
// ============================================================================

const engine = require('../lib/engine');
const candlesLib = require('../lib/candles');
const cal = require('../lib/calibration');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// ---- Deterministic synthetic market ---------------------------------------
let seed = 20260729;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function gauss() { return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()); }

const STEP_5M = 5 * 60000;
const T0 = 1700000000000;

function make5m(n, startPrice = 3000) {
  const out = [];
  let p = startPrice;
  let t = T0;
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = p * (1 + gauss() * 0.0012);
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * 0.0004);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * 0.0004);
    out.push({ openTime: t, open, high, low, close, volume: 100 * Math.exp(gauss() * 0.4), closeTime: t + STEP_5M - 1 });
    p = close;
    t += STEP_5M;
  }
  return out;
}

const SERIES = make5m(4200);
// Timeframes derived by aggregation so all views are mutually consistent.
const view = (upTo) => {
  const s5 = SERIES.slice(0, upTo);
  return {
    '5m': s5.slice(-200),
    '15m': candlesLib.aggregate(s5, 3).slice(-200),
    '60m': candlesLib.aggregate(s5, 12).slice(-200),
  };
};

// ===========================================================================
section('1. Repainting: verdicts must not move while a candle forms');

{
  // A closed history plus a candle that is still forming. We mutate the forming
  // candle through a full range of shapes — including one that manufactures a
  // textbook liquidity sweep — and assert the verdict never budges.
  const closed = SERIES.slice(0, 300);
  const lastClose = closed[closed.length - 1].close;
  const openTime = closed[closed.length - 1].closeTime + 1;
  const closeTime = openTime + STEP_5M - 1;
  const nowMidBar = openTime + Math.floor(STEP_5M / 2); // wall clock inside the bar

  const shapes = [
    { close: lastClose * 0.995, high: lastClose * 1.0005, low: lastClose * 0.9930, volume: 40 },
    { close: lastClose * 1.004, high: lastClose * 1.0060, low: lastClose * 0.9990, volume: 900 },
    { close: lastClose * 0.999, high: lastClose * 1.0010, low: lastClose * 0.9900, volume: 500 },
    { close: lastClose * 1.001, high: lastClose * 1.0020, low: lastClose * 0.9995, volume: 120 },
  ];

  const verdicts = shapes.map((s) => {
    const forming = { openTime, open: lastClose, high: s.high, low: s.low, close: s.close, volume: s.volume, closeTime };
    const raw = closed.concat([forming]);
    // This is the pipeline the live server now uses.
    const confirmed = candlesLib.closedOnly(raw, nowMidBar);
    const s5 = confirmed.slice(-200);
    return engine.decide({
      '5m': s5,
      '15m': candlesLib.aggregate(confirmed, 3).slice(-200),
      '60m': candlesLib.aggregate(confirmed, 12).slice(-200),
    });
  });

  const dirs = [...new Set(verdicts.map((v) => v.directie))];
  const nets = [...new Set(verdicts.map((v) => v.scores.net))];
  const bars = [...new Set(verdicts.map((v) => v.barCloseTime))];

  check('direction is stable across all forming-candle shapes', dirs.length === 1, `directions seen: ${dirs.join(', ')}`);
  check('score is stable across all forming-candle shapes', nets.length === 1, `nets seen: ${nets.join(', ')}`);
  check('verdict is attributed to the last CLOSED bar', bars.length === 1 && bars[0] < openTime,
    `barCloseTime=${bars[0]}, forming bar opened at ${openTime}`);

  // And the forming candle must genuinely be excluded.
  const withForming = closed.concat([{ openTime, open: lastClose, high: lastClose * 1.01, low: lastClose * 0.99, close: lastClose, volume: 999, closeTime }]);
  check('closedOnly() strips the unclosed candle',
    candlesLib.closedOnly(withForming, nowMidBar).length === closed.length,
    `${withForming.length} in -> ${candlesLib.closedOnly(withForming, nowMidBar).length} out`);
  check('closedOnly() keeps it once the bar has closed',
    candlesLib.closedOnly(withForming, closeTime + 1).length === closed.length + 1);
}

// ===========================================================================
section('2. Horizon balance: 10-minute signals must actually occur');

const signals = [];
for (let i = 260; i < SERIES.length - 6; i += 3) {
  const v = engine.decide(view(i));
  if (v.directie === 'NEUTRU') continue;
  const entry = SERIES[i - 1].close;
  const h = v.interval === '10 minute' ? 2 : 6;
  const exit = SERIES[i - 1 + h].close;
  signals.push({
    setup: v.setup,
    interval: v.interval,
    direction: v.directie,
    score: v.score,
    win: v.directie === 'UP' ? exit > entry : exit < entry,
  });
}

{
  const n10 = signals.filter((s) => s.interval === '10 minute').length;
  const n30 = signals.filter((s) => s.interval === '30 minute').length;
  const share10 = signals.length ? (n10 / signals.length) * 100 : 0;
  console.log(`  ${signals.length} signals: ${n10} x 10min (${share10.toFixed(1)}%), ${n30} x 30min`);
  check('both contract windows are produced', n10 > 0 && n30 > 0, `10min=${n10}, 30min=${n30}`);
  check('10-minute share is not vanishing (>5%)', share10 > 5, `${share10.toFixed(1)}%`);
  const setups = [...new Set(signals.map((s) => s.setup))];
  check('no signal is emitted without a real trigger', !setups.includes('context'), `setups: ${setups.join(', ')}`);
}

// ===========================================================================
section('3. Determinism: identical closed input yields identical output');

{
  const a = engine.decide(view(1500));
  const b = engine.decide(view(1500));
  const strip = (v) => JSON.stringify({ ...v, ts: 0 });
  check('decide() is a pure function of the candles', strip(a) === strip(b));
}

// ===========================================================================
section('4. Null edge: on pure noise the EV gate must refuse');

{
  const wins = signals.filter((s) => s.win).length;
  const wr = signals.length ? (wins / signals.length) * 100 : 0;
  const sig = cal.vsCoinFlip(wins, signals.length);
  console.log(`  raw win-rate on random walk: ${wr.toFixed(1)}% (${wins}/${signals.length}), z=${sig.z}, p=${sig.pValue}`);
  check('random-walk win-rate is near 50% (no look-ahead leak)', Math.abs(wr - 50) < 5, `${wr.toFixed(1)}%`);
  check('random-walk edge is NOT statistically significant', !sig.significant, `p=${sig.pValue}`);

  // Fit on the first half, gate the second half, at realistic payouts.
  const cut = Math.floor(signals.length / 2);
  const model = cal.fit(signals.slice(0, cut), { minSample: 30 });
  const held = signals.slice(cut);
  let approved = 0;
  for (const s of held) {
    const pred = cal.predict(model, s);
    const payout = s.interval === '10 minute' ? 65 : 82;
    if (cal.decide(pred, payout, { marginPct: 1.5 }).trade) approved++;
  }
  const approvedPct = held.length ? (approved / held.length) * 100 : 0;
  console.log(`  EV gate approved ${approved}/${held.length} (${approvedPct.toFixed(1)}%) of noise signals`);
  check('EV gate approves (almost) nothing on data with no edge', approvedPct < 5, `${approvedPct.toFixed(1)}% approved`);
}

// ===========================================================================
section('5. Event-futures arithmetic');

{
  // Break-even = 1/(1+payout).
  check('payout 65% needs 60.6%', Math.abs(cal.breakEvenWinRate(65) - 60.61) < 0.05, `${cal.breakEvenWinRate(65)}%`);
  check('payout 82% needs 54.9%', Math.abs(cal.breakEvenWinRate(82) - 54.95) < 0.05, `${cal.breakEvenWinRate(82)}%`);
  check('payout 100% needs 50%', Math.abs(cal.breakEvenWinRate(100) - 50) < 0.01);
  check('EV is zero exactly at break-even',
    Math.abs(cal.expectedValue(cal.breakEvenWinRate(65), 65)) < 0.05,
    `EV=${cal.expectedValue(cal.breakEvenWinRate(65), 65)}%`);
  check('EV is negative below break-even', cal.expectedValue(55, 65) < 0, `EV=${cal.expectedValue(55, 65)}%`);
  check('EV is positive above break-even', cal.expectedValue(65, 65) > 0, `EV=${cal.expectedValue(65, 65)}%`);

  // A small sample must never be treated as an edge, however good it looks.
  const tiny = cal.wilson(14, 25); // 56% off 25 samples
  check('56% off 25 samples has a lower bound below break-even', tiny.low < cal.breakEvenWinRate(82),
    `CI low ${tiny.low}% vs break-even ${cal.breakEvenWinRate(82)}%`);
  const gateTiny = cal.decide({ ready: true, probability: 56, ciLow: tiny.low, ciHigh: tiny.high, n: 25 }, 82);
  check('EV gate refuses that sample', !gateTiny.trade, gateTiny.reason);

  // Unknown probability must never be silently treated as tradeable.
  const gateBlind = cal.decide({ ready: false, source: 'no data' }, 82);
  check('EV gate refuses when probability is unknown', !gateBlind.trade && gateBlind.needsData === true);
}

// ===========================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
