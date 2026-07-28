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

const DEFAULT_MIN_SAMPLE = 30;

function wilsonLowerBound(wins, n, z = 1.645) {
  if (!n) return null;
  const p = wins / n;
  const z2 = z * z;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / (1 + z2 / n));
}

function agg(arr) {
  const n = arr.length;
  const wins = arr.filter((e) => e.win).length;
  const lower = wilsonLowerBound(wins, n);
  const winRateRaw = n ? (wins / n) * 100 : null;
  const lowerBoundRaw = lower == null ? null : lower * 100;
  return {
    n,
    wins,
    winRateRaw,
    lowerBoundRaw,
    winRate: winRateRaw == null ? null : +winRateRaw.toFixed(1),
    lowerBound: lowerBoundRaw == null ? null : +lowerBoundRaw.toFixed(1),
  };
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
    bySymbolDirInterval: bucketize(resolved, (e) => `${e.symbol}-${e.directie}-${e.interval}`),
    byOfAgree: bucketize(resolved, (e) => (e.ofAgree ? `of:${e.ofAgree}` : null)),
    byInterval: bucketize(resolved, (e) => e.interval),
  };
}

// Evaluate a new signal's context against learned stats.
// Returns { estimate, adjustment, ready, factors } where estimate is a blended
// win-rate guess (%) and adjustment is (estimate - 50).
function evaluate(entries, ctx, minSample = DEFAULT_MIN_SAMPLE) {
  const calibrationEntries = ctx.calibrationVersion != null
    ? entries.filter((entry) => entry.observation && entry.entrySource === 'boundary-1m-open' &&
      entry.calibrationVersion === ctx.calibrationVersion && entry.settlementSource === 'aggTrade-exact')
    : entries;
  const a = analyze(calibrationEntries);
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
  if (ctx.interval) {
    pull(a.byInterval, ctx.interval, `fereastră ${ctx.interval}`);
    pull(a.bySymbolDirInterval, `${ctx.symbol}-${ctx.directie}-${ctx.interval}`, `${ctx.symbol} ${ctx.directie} ${ctx.interval}`);
  }
  if (ctx.ofAgree) pull(a.byOfAgree, `of:${ctx.ofAgree}`, `order flow ${ctx.ofAgree}`);

  // Forecast calibration is horizon, symbol and direction specific. Broad
  // marginal buckets may explain context but cannot unlock execution.
  if (ctx.requireInterval) {
    const cohortKey = `${ctx.symbol}-${ctx.directie}-${ctx.interval}`;
    const cohort = a.bySymbolDirInterval[cohortKey];
    if (!cohort || cohort.n < minSample || cohort.winRate == null) {
      const n = cohort ? cohort.n : 0;
      return {
        ready: false,
        estimate: null,
        lowerBound: null,
        sampleSize: n,
        adjustment: 0,
        factors,
        note: `calibrare ${ctx.symbol} ${ctx.directie} ${ctx.interval}: ${n}/${minSample} rezultate forward exacte`,
      };
    }
  }

  if (!factors.length) {
    return { ready: false, estimate: null, adjustment: 0, factors: [], note: 'încă strâng date — nimic învățat sigur' };
  }

  if (ctx.requireInterval) {
    const cohort = a.bySymbolDirInterval[`${ctx.symbol}-${ctx.directie}-${ctx.interval}`];
    const estimate = cohort.winRateRaw;
    return {
      ready: true,
      estimate,
      displayEstimate: cohort.winRate,
      lowerBound: cohort.lowerBoundRaw,
      displayLowerBound: cohort.lowerBound,
      sampleSize: cohort.n,
      adjustment: +(estimate - 50).toFixed(1),
      factors,
      note: `probabilitate empirică ${ctx.symbol} ${ctx.directie} ${ctx.interval}: ${cohort.winRate}% din ${cohort.n} rezultate; limită conservatoare ${cohort.lowerBound}%`,
    };
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
  collect(a.bySymbolDirInterval, 'monedă+dir+fereastră');
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

module.exports = { analyze, evaluate, summary, wilsonLowerBound, DEFAULT_MIN_SAMPLE };
