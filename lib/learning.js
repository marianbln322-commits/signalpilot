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

const DEFAULT_MIN_SAMPLE = 10;

function agg(arr) {
  const n = arr.length;
  const wins = arr.filter((e) => e.win).length;
  return { n, wins, winRate: n ? +((wins / n) * 100).toFixed(1) : null };
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
//
// Background bar samples are EXCLUDED by default. They outnumber real alerts by
// roughly 60:1, so including them makes every bucket converge to the
// unconditional base rate (~50%) — which would then trip the suppression
// threshold and veto genuine alerts on evidence that never described them.
// Pass { includeBackground: true } only to inspect that population on purpose.
function analyze(entries, opts = {}) {
  const includeBackground = !!opts.includeBackground;
  const resolved = entries.filter(
    (e) => e.status === 'resolved' && (includeBackground || !e.background)
  );
  return {
    total: resolved.length,
    bySetup: bucketize(resolved, (e) => e.setup || 'necunoscut'),
    byHour: bucketize(resolved, (e) => (e.hourUTC != null ? `h${e.hourUTC}` : null)),
    bySymbolDir: bucketize(resolved, (e) => `${e.symbol}-${e.directie}`),
    byOfAgree: bucketize(resolved, (e) => (e.ofAgree ? `of:${e.ofAgree}` : null)),
    byInterval: bucketize(resolved, (e) => e.interval),
  };
}

// Evaluate a new signal's context against learned stats.
// Returns { estimate, adjustment, ready, factors } where estimate is a blended
// win-rate guess (%) and adjustment is (estimate - 50).
function evaluate(entries, ctx, minSample = DEFAULT_MIN_SAMPLE) {
  // Real alerts only — this can veto a trade, so it must be based on the
  // population that is actually traded.
  const a = analyze(entries);
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
  if (ctx.ofAgree) pull(a.byOfAgree, `of:${ctx.ofAgree}`, `order flow ${ctx.ofAgree}`);

  if (!factors.length) {
    return { ready: false, estimate: null, adjustment: 0, factors: [], note: 'încă strâng date — nimic învățat sigur' };
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
  const bg = analyze(entries, { includeBackground: true });
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
  collect(a.byOfAgree, 'order flow');
  collect(a.byInterval, 'fereastră');
  rows.sort((x, y) => y.winRate - x.winRate);
  return {
    total: a.total,
    ready: rows.length > 0,
    best: rows.slice(0, 5),
    worst: rows.slice(-5).reverse(),
    minSample,
    // The unconditional baseline, reported separately and never blended in. It
    // answers the question that actually matters: is the filtered setup better
    // than simply taking every bar?
    baseline: {
      total: bg.total - a.total,
      note: 'toate barele observate (nefiltrate) — reper de comparație',
    },
  };
}

module.exports = { analyze, evaluate, summary, DEFAULT_MIN_SAMPLE };
