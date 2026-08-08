#!/usr/bin/env node
'use strict';

// ============================================================================
// train.js — learns the weights instead of asserting them, and validates
// walk-forward with purging.
//
// WHAT THIS REPLACES
// engine.js scored setups with hand-written constants (sweep 3.0, MSS 2.2, trend
// 1.5). This fits those relationships to labelled outcomes and reports how the
// result behaves on data it never saw.
//
// THREE THINGS THAT MAKE THE NUMBER TRUSTWORTHY
//
// 1. PURGING. A sample at bar i is labelled by bar i+H, so samples i..i+H-1 share
//    outcome windows. Training on i while testing on i+1 leaks the answer. Every
//    train/test boundary therefore drops H bars.
//
// 2. NON-OVERLAPPING CONFIDENCE INTERVALS. Because neighbouring labels overlap,
//    n consecutive samples carry roughly n/H independent observations. Reporting a
//    binomial interval over all of them would understate the error bars by a
//    factor of about sqrt(H). Both are printed: the naive interval and the honest
//    one computed on a stride-H subsample.
//
// 3. A NULL TEST. --synthetic replaces the market with a driftless random walk.
//    Out-of-sample accuracy must land on ~50%. If it does not, the harness is
//    broken and no result from it means anything.
//
// USAGE
//   node tools/train.js --synthetic --days 120        # sanity check, no network
//   node tools/train.js --symbol ETHUSDT --days 365   # real history (needs net)
//   node tools/train.js --symbol ETHUSDT --days 365 --horizon 30 --save
// ============================================================================

const fs = require('fs');
const path = require('path');
const features = require('../lib/features');
const model = require('../lib/model');
const cal = require('../lib/calibration');
const candles = require('../lib/candles');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (name) => process.argv.includes(`--${name}`);

// ---- Synthetic market: the null hypothesis ---------------------------------
function synthetic(nBars, seed = 1, startPrice = 3000, sigma1m = 0.0011) {
  let s = seed;
  const rnd = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = () => {
    let u = 0; let v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out = [];
  let p = startPrice;
  const t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < nBars; i++) {
    const open = p;
    let hi = open; let lo = open;
    for (let k = 0; k < 5; k++) {
      p *= Math.exp(sigma1m * g());
      if (p > hi) hi = p;
      if (p < lo) lo = p;
    }
    const openTime = t0 + i * 5 * 60 * 1000;
    const volume = Math.exp(3 + 0.6 * g()) * 100;
    out.push({
      openTime, open, high: hi, low: lo, close: p, volume,
      closeTime: openTime + 5 * 60 * 1000 - 1, quoteVolume: volume * p,
    });
  }
  return out;
}

// ---- Dataset ---------------------------------------------------------------
const WINDOW = 200;

// Progress reporting exists because the two heavy phases are otherwise silent for
// several minutes on a year of 5-minute bars, and a silent terminal is
// indistinguishable from a hung one.
function progress(label, done, total, t0) {
  const pct = (done / total) * 100;
  const el = (Date.now() - t0) / 1000;
  const eta = done > 0 ? (el / done) * (total - done) : 0;
  process.stdout.write(
    `\r  ${label}: ${done}/${total} (${pct.toFixed(1)}%)  ` +
    `scurs ${el.toFixed(0)}s  rămas ~${eta.toFixed(0)}s      `
  );
}

function buildDataset(tf5, horizonBars) {
  // 15m and 60m are derived from the 5m series rather than fetched separately, so
  // boundaries line up exactly and no timeframe can be accidentally ahead of
  // another.
  const tf15 = candles.aggregate(tf5, 3);
  const tf60 = candles.aggregate(tf5, 12);

  const samples = [];
  let names = null;
  const total = tf5.length - horizonBars - WINDOW;
  const t0 = Date.now();
  let lastPrint = 0;
  for (let i = WINDOW; i < tf5.length - horizonBars; i++) {
    if (Date.now() - lastPrint > 500) {
      lastPrint = Date.now();
      progress('features', i - WINDOW, total, t0);
    }
    const ct = tf5[i].closeTime;
    const w5 = tf5.slice(Math.max(0, i - WINDOW), i + 1);
    const w15 = candles.upTo(tf15, ct).slice(-WINDOW);
    const w60 = candles.upTo(tf60, ct).slice(-WINDOW);
    if (w15.length < 60 || w60.length < 60) continue;

    const f = features.extract({ '5m': w5, '15m': w15, '60m': w60 });
    if (!f) continue;
    if (!names) names = features.featureNames(f);

    const entry = tf5[i].close;
    const exit = tf5[i + horizonBars].close;
    if (exit === entry) continue; // a tie is a refund: no directional label
    samples.push({
      i,
      ts: tf5[i].openTime,
      x: features.vectorize(f, names),
      y: exit > entry,
    });
  }
  progress('features', total, total, t0);
  process.stdout.write('\n');
  return { samples, names };
}

// ---- Walk-forward ----------------------------------------------------------
// Regularisation strength is a hyperparameter, so it cannot be chosen by looking
// at the test folds — that is leakage, and it is how a mediocre model acquires a
// flattering number. It is selected INSIDE each fold: the tail of the training
// block is held out as validation, the grid is scored on that, and only then is
// the winner refitted on the full training block and applied to the test block.
const L2_GRID = [0.05, 0.2, 1, 5, 20];

function selectL2(tr, epochs, seed, onStep) {
  const cut = Math.floor(tr.length * 0.8);
  const a = tr.slice(0, cut);
  const b = tr.slice(cut + 1); // +1 keeps a small purge between fit and validation
  if (b.length < 100) return { l2: 1, note: 'prea puține date de validare' };
  let best = null;
  for (const l2 of L2_GRID) {
    if (onStep) onStep(l2);
    const m = model.fit(a.map((s) => s.x), a.map((s) => s.y), { l2, epochs, seed });
    const p = model.predict(m, b.map((s) => s.x));
    const ll = model.logLoss(p, b.map((s) => s.y));
    if (!best || ll < best.ll) best = { l2, ll };
  }
  return best;
}

function walkForward(samples, names, horizonBars, opts = {}) {
  const folds = opts.folds || 6;
  const minTrain = opts.minTrain || Math.floor(samples.length * 0.3);
  const blockSize = Math.floor((samples.length - minTrain) / folds);
  const oos = [];
  const perFold = [];
  const t0 = Date.now();

  console.log(`\n  Antrenare: ${folds} fold-uri x (${L2_GRID.length} candidați L2 + 1 fit final)`);
  for (let k = 0; k < folds; k++) {
    const trainEnd = minTrain + k * blockSize;
    // Purge: drop `horizonBars` samples so no training label overlaps a test one.
    const testStart = trainEnd + horizonBars;
    const testEnd = Math.min(samples.length, testStart + blockSize);
    if (testEnd - testStart < 50) continue;

    const tr = samples.slice(0, trainEnd);
    const te = samples.slice(testStart, testEnd);
    const chosen = opts.l2 != null
      ? { l2: opts.l2 }
      : selectL2(tr, opts.epochs, 7 + k, (l2) => {
        process.stdout.write(
          `\r    fold ${k + 1}/${folds}  train ${tr.length}  caut L2=${l2}...` +
          `   scurs ${((Date.now() - t0) / 1000).toFixed(0)}s      `
        );
      });
    process.stdout.write(
      `\r    fold ${k + 1}/${folds}  train ${tr.length}  L2=${chosen.l2}  fit final...` +
      `   scurs ${((Date.now() - t0) / 1000).toFixed(0)}s      `
    );
    const m = model.fit(tr.map((s) => s.x), tr.map((s) => s.y), {
      l2: chosen.l2, epochs: opts.epochs, seed: 7 + k,
    });
    const p = model.predict(m, te.map((s) => s.x));
    const y = te.map((s) => s.y);

    perFold.push({
      fold: k + 1,
      train: tr.length,
      test: te.length,
      l2: chosen.l2,
      brier: +model.brier(p, y).toFixed(5),
      acc: +(model.accuracyAtThreshold(p, y, 0.5).accuracy * 100).toFixed(2),
    });
    for (let j = 0; j < te.length; j++) oos.push({ p: p[j], y: y[j], i: te[j].i });
  }
  process.stdout.write(`\r  Antrenare gata în ${((Date.now() - t0) / 1000).toFixed(0)}s` + ' '.repeat(40) + '\n');
  return { oos, perFold };
}

function report(oos, horizonBars, label) {
  const p = oos.map((o) => o.p);
  const y = oos.map((o) => o.y);
  const base = (y.filter(Boolean).length / y.length) * 100;

  console.log(`\n  eșantioane out-of-sample : ${oos.length}`);
  console.log(`  rata de bază (UP)        : ${base.toFixed(2)}%`);
  console.log(`  Brier                    : ${model.brier(p, y).toFixed(5)}  (0.25 = a spune mereu 50%)`);
  console.log(`  log loss                 : ${model.logLoss(p, y).toFixed(5)}  (0.6931 = 50/50)`);

  console.log('\n  prag     acoperire        n   acuratețe   CI 95% naiv        CI 95% ONEST (stride)');
  for (const th of [0.5, 0.52, 0.55, 0.58, 0.60, 0.65]) {
    const a = model.accuracyAtThreshold(p, y, th);
    if (!a.n || a.n < 20) continue;
    const naive = cal.wilson(a.correct, a.n);

    // Honest interval: keep only picks at least `horizonBars` apart, so the
    // outcome windows do not overlap and the observations are independent.
    let lastIdx = -1e9; let n2 = 0; let c2 = 0;
    for (const o of oos) {
      const conf = Math.abs(o.p - 0.5) + 0.5;
      if (conf < th) continue;
      if (o.i - lastIdx < horizonBars) continue;
      lastIdx = o.i;
      n2++;
      if ((o.p > 0.5) === !!o.y) c2++;
    }
    const honest = n2 > 10 ? cal.wilson(c2, n2) : null;
    console.log(
      `  ${th.toFixed(2)}   ${(a.coverage * 100).toFixed(1)}%`.padEnd(19) +
      String(a.n).padStart(7) +
      `${(a.accuracy * 100).toFixed(2)}%`.padStart(12) +
      `${naive.low}–${naive.high}%`.padStart(18) +
      (honest ? `${honest.low}–${honest.high}%  (n=${n2})`.padStart(26) : '—'.padStart(26))
    );
  }

  // The only question that matters: does the honest lower bound clear break-even?
  console.log('\n  VERDICT vs break-even:');
  for (const payout of [80, 85]) {
    const be = cal.breakEvenWinRate(payout);
    let best = null;
    for (const th of [0.5, 0.52, 0.55, 0.58, 0.6, 0.65]) {
      let lastIdx = -1e9; let n2 = 0; let c2 = 0;
      for (const o of oos) {
        const conf = Math.abs(o.p - 0.5) + 0.5;
        if (conf < th) continue;
        if (o.i - lastIdx < horizonBars) continue;
        lastIdx = o.i; n2++;
        if ((o.p > 0.5) === !!o.y) c2++;
      }
      if (n2 < 30) continue;
      const wl = cal.wilson(c2, n2);
      if (!best || wl.low > best.low) best = { th, low: wl.low, acc: (c2 / n2) * 100, n: n2 };
    }
    if (!best) { console.log(`    payout ${payout}%: prea puține eșantioane independente`); continue; }
    const pass = best.low >= be;
    console.log(
      `    payout ${payout}%  break-even ${be}%  |  cel mai bun prag ${best.th}: ` +
      `${best.acc.toFixed(2)}% (n=${best.n}), limita inf. ${best.low}%  =>  ${pass ? 'TRECE' : 'NU trece'}`
    );
  }
  return { label };
}

// Empirical reliability: for each confidence band, what the model ACTUALLY got
// right out-of-sample. This is the bridge between a model output and a number the
// EV gate is allowed to trust. Counted on a stride-H subsample so overlapping
// outcome windows do not shrink the intervals.
const CONF_BANDS = [
  [0.500, 0.520], [0.520, 0.550], [0.550, 0.580],
  [0.580, 0.600], [0.600, 0.650], [0.650, 1.001],
];

function reliabilityTable(oos, horizonBars) {
  return CONF_BANDS.map(([lo, hi]) => {
    let lastIdx = -1e9;
    let n = 0;
    let correct = 0;
    for (const o of oos) {
      const conf = Math.max(o.p, 1 - o.p);
      if (conf < lo || conf >= hi) continue;
      if (o.i - lastIdx < horizonBars) continue; // independence
      lastIdx = o.i;
      n++;
      if ((o.p > 0.5) === !!o.y) correct++;
    }
    const w = n > 10 ? cal.wilson(correct, n) : null;
    const w90 = n > 10 ? cal.wilson(correct, n, 1.2816) : null;
    return {
      lo, hi, n, correct,
      accuracy: n ? +((correct / n) * 100).toFixed(2) : null,
      ciLow: w ? w.low : null,
      ciHigh: w ? w.high : null,
      ciLow90: w90 ? w90.low : null,
    };
  });
}

// ---- Main ------------------------------------------------------------------
(async () => {
  const horizonMin = Number(arg('horizon', 10));
  const horizonBars = horizonMin === 30 ? 6 : 2;
  const days = Number(arg('days', 120));
  const symbol = String(arg('symbol', 'ETHUSDT'));
  const l2 = process.argv.includes('--l2') ? Number(arg('l2', 1)) : null;
  const epochs = Number(arg('epochs', 200));
  const file = arg('file', null);

  let tf5;
  let source;
  if (has('synthetic')) {
    tf5 = synthetic(days * 288, Number(arg('seed', 1)));
    source = `RANDOM WALK sintetic (${days} zile) — test de nul`;
  } else if (file) {
    // Preferred path: data collected once by tools/collect.js on a machine with
    // network access. Reading from disk also makes runs reproducible.
    const p = path.isAbsolute(String(file)) ? String(file) : path.join(__dirname, '..', String(file));
    tf5 = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(tf5) || !tf5.length) throw new Error(`fișier gol sau invalid: ${p}`);
    const first = new Date(tf5[0].openTime).toISOString().slice(0, 10);
    const lastD = new Date(tf5[tf5.length - 1].openTime).toISOString().slice(0, 10);
    source = `${path.basename(p)} — ${tf5.length} bare, ${first} -> ${lastD}`;
  } else {
    const binance = require('../lib/binance');
    tf5 = await binance.fetchHistory(symbol, '5m', days, 1000, null);
    source = `${symbol} istoric real (${days} zile, ${tf5.length} bare)`;
  }

  console.log('='.repeat(84));
  console.log('  TRAIN — ponderi ÎNVĂȚATE, validare walk-forward cu purjare');
  console.log('='.repeat(84));
  console.log(`  sursă     : ${source}`);
  console.log(`  orizont   : ${horizonMin} min (${horizonBars} bare de 5m)`);
  console.log(`  L2        : ${l2 == null ? `ales automat din [${L2_GRID.join(', ')}] pe validare internă` : l2}`);
  console.log(`  epoci     : ${epochs}`);

  const { samples, names } = buildDataset(tf5, horizonBars);
  console.log(`  features  : ${names ? names.length : 0}`);
  console.log(`  eșantioane: ${samples.length}`);
  if (samples.length < 500) {
    console.error('\n  Prea puține eșantioane. Cere mai multe zile.');
    process.exit(1);
  }

  const { oos, perFold } = walkForward(samples, names, horizonBars, { l2, epochs });
  console.log('\n  Pe fold (out-of-sample):');
  for (const f of perFold) {
    console.log(`    fold ${f.fold}: train ${String(f.train).padStart(6)}  test ${String(f.test).padStart(5)}  ` +
      `L2 ${String(f.l2).padStart(5)}  acc ${f.acc}%  Brier ${f.brier}`);
  }

  report(oos, horizonBars, source);

  if (has('save')) {
    const finalL2 = l2 != null ? l2 : (perFold.length
      ? perFold.map((f) => f.l2).sort((a, b) => perFold.filter((x) => x.l2 === a).length - perFold.filter((x) => x.l2 === b).length).pop()
      : 1);
    const m = model.fit(samples.map((s) => s.x), samples.map((s) => s.y), { l2: finalL2, epochs, seed: 11 });
    const out = {
      version: 2,
      kind: 'logistic',
      symbol: has('synthetic') ? 'SYNTHETIC' : symbol,
      horizonMin,
      horizonBars,
      names,
      ...m,
      l2: finalL2,
      // The raw logistic output is NOT what the gate may act on. A model can say
      // 0.58 while predictions in that band were right 50% of the time
      // out-of-sample. This table records what each confidence band ACTUALLY
      // achieved on data the model never saw, measured on a stride-H subsample so
      // the intervals are not inflated by overlapping labels. The live path looks
      // the model's output up in here and hands the gate the measured figure.
      reliability: reliabilityTable(oos, horizonBars),
      fittedAt: Date.now(),
    };
    const dir = path.join(__dirname, '..', 'models');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${out.symbol}-${horizonMin}m.json`);
    fs.writeFileSync(p, JSON.stringify(out, null, 2));
    console.log(`\n  model salvat: ${p}`);
    console.log('\n  Fiabilitate măsurată out-of-sample (ce foloseste poarta):');
    console.log('    bandă încredere      n   acuratețe reală   CI low 90%');
    for (const r of out.reliability) {
      if (!r.n) continue;
      console.log(
        `    ${r.lo.toFixed(2)}–${r.hi >= 1 ? '1.00' : r.hi.toFixed(2)}` +
        String(r.n).padStart(9) + `${r.accuracy}%`.padStart(16) +
        `${r.ciLow90 != null ? r.ciLow90 + '%' : '—'}`.padStart(14)
      );
    }
    console.log('\n  Ponderi dominante (pe features standardizate):');
    for (const t of model.topWeights(m, names, 15)) {
      console.log(`    ${t.weight >= 0 ? '+' : ''}${t.weight}  ${t.name}`);
    }
  }
  console.log('\n' + '='.repeat(84));
})();
