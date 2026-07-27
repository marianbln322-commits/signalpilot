'use strict';

// Conservative journal calibration. It selects one progressively broader cohort
// instead of averaging correlated marginal win-rates as if they were independent.
const DEFAULT_MIN_SAMPLE = 20;
const PRIOR_WINS = 5;
const PRIOR_LOSSES = 5;
const HALF_LIFE_DAYS = 90;

function uniqueResolved(entries) {
  const byEvent = new Map();
  for (const e of entries) {
    if (e.status !== 'resolved' || typeof e.win !== 'boolean') continue;
    const timeBucket = e.decisionCandleTs ?? Math.floor((e.entryTs || 0) / (5 * 60 * 1000));
    const key = e.eventId || `${e.symbol}:${timeBucket}:${e.directie}`;
    const previous = byEvent.get(key);
    if (!previous || (e.alerted && !previous.alerted)) byEvent.set(key, e);
  }
  // Keep non-overlapping outcomes per symbol. This is an embargo, not a claim
  // that BTC and ETH are independent; it prevents six 30m labels from the same
  // move being counted as six Bernoulli trials.
  const independent = [];
  const blockedUntil = new Map();
  const ordered = [...byEvent.values()].sort((a, b) => (a.entryTs || 0) - (b.entryTs || 0));
  for (const e of ordered) {
    const start = Number(e.entryTs) || 0;
    const end = Number(e.resolveTs) || start;
    if (start < (blockedUntil.get(e.symbol) || 0)) continue;
    independent.push(e);
    blockedUntil.set(e.symbol, end);
  }
  return independent;
}

function wilson(wins, n, z = 1.96) {
  if (!n) return { lower: null, upper: null };
  const p = wins / n;
  const denom = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return {
    lower: +(((centre - spread) / denom) * 100).toFixed(1),
    upper: +(((centre + spread) / denom) * 100).toFixed(1),
  };
}

function agg(arr) {
  const n = arr.length;
  const wins = arr.filter((e) => e.win).length;
  const bounds = wilson(wins, n);
  return { n, wins, winRate: n ? +((wins / n) * 100).toFixed(1) : null, ...bounds };
}

function bucketize(resolved, keyFn) {
  const map = {};
  for (const e of resolved) {
    const key = keyFn(e);
    if (key == null) continue;
    (map[key] = map[key] || []).push(e);
  }
  return Object.fromEntries(Object.entries(map).map(([key, rows]) => [key, agg(rows)]));
}

function analyze(entries, policyVersion = null) {
  const scoped = policyVersion ? entries.filter((e) => e.policyVersion === policyVersion) : entries;
  const resolved = uniqueResolved(scoped);
  return {
    total: resolved.length,
    bySetup: bucketize(resolved, (e) => e.setup || 'necunoscut'),
    byHour: bucketize(resolved, (e) => (e.hourUTC != null ? `h${e.hourUTC}` : null)),
    bySymbolDir: bucketize(resolved, (e) => `${e.symbol}-${e.directie}`),
    byOfAgree: bucketize(resolved, (e) => (e.ofAgree ? `of:${e.ofAgree}` : null)),
    byInterval: bucketize(resolved, (e) => e.interval),
  };
}

function weightedPosterior(rows, now = Date.now()) {
  let wins = PRIOR_WINS;
  let losses = PRIOR_LOSSES;
  let effectiveN = 0;
  for (const e of rows) {
    const ageDays = Math.max(0, now - (e.entryTs || now)) / 86400000;
    const weight = 0.5 ** (ageDays / HALF_LIFE_DAYS);
    effectiveN += weight;
    if (e.win) wins += weight;
    else losses += weight;
  }
  const total = wins + losses;
  const p = wins / total;
  const sd = Math.sqrt((wins * losses) / (total * total * (total + 1)));
  return {
    estimate: +(p * 100).toFixed(1),
    lower: +(Math.max(0, p - 1.96 * sd) * 100).toFixed(1),
    upper: +(Math.min(1, p + 1.96 * sd) * 100).toFixed(1),
    effectiveN: +effectiveN.toFixed(1),
  };
}

function evaluate(entries, ctx, minSample = DEFAULT_MIN_SAMPLE) {
  const scoped = ctx.policyVersion ? entries.filter((e) => e.policyVersion === ctx.policyVersion) : entries;
  const resolved = uniqueResolved(scoped);
  const dimensions = [
    ['setup + simbol + direcție + interval + order flow', (e) =>
      e.setup === ctx.setup && e.symbol === ctx.symbol && e.directie === ctx.directie &&
      e.interval === ctx.interval && ctx.ofAgree && e.ofAgree === ctx.ofAgree],
    ['setup + simbol + direcție + interval', (e) =>
      e.setup === ctx.setup && e.symbol === ctx.symbol && e.directie === ctx.directie && e.interval === ctx.interval],
    ['setup + interval', (e) => e.setup === ctx.setup && e.interval === ctx.interval],
    ['simbol + direcție + interval', (e) =>
      e.symbol === ctx.symbol && e.directie === ctx.directie && e.interval === ctx.interval],
    ['interval', (e) => e.interval === ctx.interval],
  ];

  let selected = null;
  for (const [label, predicate] of dimensions) {
    const rows = resolved.filter(predicate);
    const posterior = weightedPosterior(rows);
    if (posterior.effectiveN >= minSample) {
      selected = { label, rows, posterior };
      break;
    }
  }
  if (!selected) {
    return {
      ready: false, estimate: null, lower: null, upper: null, adjustment: 0, factors: [],
      note: `încă strâng date independente — minimum ${minSample} pentru o cohortă comparabilă`,
    };
  }

  const posterior = selected.posterior;
  return {
    ready: true,
    ...posterior,
    adjustment: +(posterior.estimate - 50).toFixed(1),
    factors: [{ label: selected.label, n: selected.rows.length, ...posterior }],
    note: `estimare conservatoare ${posterior.estimate}% (interval aproximativ 95%: ${posterior.lower}–${posterior.upper}%, ${selected.rows.length} evenimente)`,
  };
}

function summary(entries, minSample = DEFAULT_MIN_SAMPLE, policyVersion = null) {
  const a = analyze(entries, policyVersion);
  const rows = [];
  const collect = (map, prefix) => {
    for (const [key, value] of Object.entries(map)) {
      if (value.n >= minSample && value.winRate != null) rows.push({ key: `${prefix}: ${key}`, ...value });
    }
  };
  collect(a.bySetup, 'setup');
  collect(a.byHour, 'oră');
  collect(a.bySymbolDir, 'monedă+dir');
  collect(a.byOfAgree, 'order flow');
  collect(a.byInterval, 'fereastră');
  rows.sort((x, y) => y.lower - x.lower || y.n - x.n);
  return {
    total: a.total,
    ready: rows.length > 0,
    best: rows.slice(0, 5),
    worst: [...rows].sort((x, y) => x.upper - y.upper || y.n - x.n).slice(0, 5),
    minSample,
    method: 'evenimente deduplicate și fără ferestre suprapuse; Wilson 95%; aproximare Beta 95% cu decay 90 zile',
  };
}

module.exports = { analyze, evaluate, summary, uniqueResolved, wilson, DEFAULT_MIN_SAMPLE };
