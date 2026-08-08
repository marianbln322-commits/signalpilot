'use strict';

// ============================================================================
// calibration.js — the event-futures decision layer.
//
// WHY THIS EXISTS
// A binary event contract does not pay you for being directionally right; it
// pays you for being right MORE OFTEN THAN THE PAYOUT REQUIRES. With a payout of
// p (e.g. 0.65 for +65%), staking 1 unit returns +p on a win and -1 on a loss,
// so expected value is:
//
//     EV = w*p - (1-w)        where w = true win probability
//
// EV turns positive only when w > 1/(1+p). That break-even is brutal:
//
//     payout 40% -> need 71.4%      payout 65% -> need 60.6%
//     payout 80% -> need 55.6%      payout 85% -> need 54.1%
//
// So the only number that matters for this instrument is a CALIBRATED
// probability — "70%" has to mean the thing actually happens 70% of the time.
// A raw confluence score ("net = 6.19") is not a probability and must never be
// treated as one.
//
// WHAT THIS MODULE DOES
//   fit()      -> learns score/setup buckets -> empirical win rate, from history
//   predict()  -> maps a new signal to a probability WITH an uncertainty interval
//   decide()   -> compares the CONSERVATIVE bound against break-even
//
// WHAT IT DELIBERATELY WILL NOT DO
// It never invents a probability. If a bucket has too few resolved samples, it
// reports ready:false and the app must say "not enough data" rather than print a
// confident-looking number. Uncertainty is surfaced, not hidden.
// ============================================================================

const DEFAULT_MIN_SAMPLE = 30;   // per-bucket minimum before a rate is trusted
const Z_95 = 1.959963985;        // two-sided 95%
const Z_ONE_SIDED_90 = 1.2815516; // for the conservative lower bound

// ---- Event-futures arithmetic ----------------------------------------------

// Win rate (%) needed just to break even at a given payout (%).
function breakEvenWinRate(payoutPct) {
  const p = Number(payoutPct) / 100;
  if (!Number.isFinite(p) || p <= 0) return null;
  return +((100 / (1 + p))).toFixed(2);
}

// Expected value per 1 unit staked, as a percentage of the stake.
function expectedValue(winRatePct, payoutPct) {
  const w = Number(winRatePct) / 100;
  const p = Number(payoutPct) / 100;
  if (!Number.isFinite(w) || !Number.isFinite(p)) return null;
  return +(((w * p) - (1 - w)) * 100).toFixed(2);
}

// Kelly-optimal fraction of bankroll for a binary payout. Reported for context
// only — it assumes the probability is exactly right, which it never is.
function kellyFraction(winRatePct, payoutPct) {
  const w = Number(winRatePct) / 100;
  const p = Number(payoutPct) / 100;
  if (!Number.isFinite(w) || !Number.isFinite(p) || p <= 0) return 0;
  const f = (w * (1 + p) - 1) / p;
  return +Math.max(0, Math.min(1, f)).toFixed(4);
}

// ---- Statistics ------------------------------------------------------------

// Wilson score interval — well behaved for small n and for rates near 0/1,
// unlike the normal approximation.
function wilson(wins, n, z = Z_95) {
  if (!n) return { low: null, high: null, mid: null };
  const phat = wins / n;
  const z2n = (z * z) / n;
  const denom = 1 + z2n;
  const center = (phat + z2n / 2) / denom;
  const half = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  return {
    low: +Math.max(0, (center - half) * 100).toFixed(2),
    // The bound is already expressed in percent, so it clamps at 100, not at 1.
    // Clamping at 1 silently turned every upper bound into "1%".
    high: +Math.min(100, (center + half) * 100).toFixed(2),
    mid: +(phat * 100).toFixed(2),
  };
}

// One-sided binomial test against a fair coin: "is this better than 50%?"
// Returns the z statistic and an approximate p-value. This is the honesty check
// that separates a real edge from a lucky streak.
function vsCoinFlip(wins, n) {
  if (!n) return { z: null, pValue: null, significant: false };
  const phat = wins / n;
  const se = Math.sqrt(0.25 / n);
  const z = (phat - 0.5) / se;
  // Normal tail approximation (Abramowitz & Stegun 7.1.26 style erf).
  const erf = (x) => {
    const s = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return s * y;
  };
  const pValue = +(0.5 * (1 - erf(z / Math.SQRT2))).toFixed(4);
  return { z: +z.toFixed(2), pValue, significant: pValue < 0.05 };
}

// Brier score: mean squared error of probabilistic forecasts. Lower is better;
// 0.25 is what you get by always saying 50%.
function brierScore(samples) {
  const usable = samples.filter((s) => Number.isFinite(s.probability) && typeof s.win === 'boolean');
  if (!usable.length) return null;
  const sum = usable.reduce((acc, s) => {
    const p = s.probability / 100;
    return acc + (p - (s.win ? 1 : 0)) ** 2;
  }, 0);
  return +(sum / usable.length).toFixed(4);
}

// Reliability table: are forecasts of "X%" actually right X% of the time?
function reliability(samples, binCount = 5) {
  const usable = samples.filter((s) => Number.isFinite(s.probability) && typeof s.win === 'boolean');
  const bins = [];
  for (let i = 0; i < binCount; i++) {
    const lo = 40 + (i * 30) / binCount;   // focus on the 40-70% region that matters
    const hi = 40 + ((i + 1) * 30) / binCount;
    const inBin = usable.filter((s) => s.probability >= lo && s.probability < hi);
    const wins = inBin.filter((s) => s.win).length;
    bins.push({
      range: `${lo.toFixed(0)}-${hi.toFixed(0)}%`,
      n: inBin.length,
      predicted: inBin.length ? +(inBin.reduce((a, s) => a + s.probability, 0) / inBin.length).toFixed(1) : null,
      actual: inBin.length ? +((wins / inBin.length) * 100).toFixed(1) : null,
    });
  }
  return bins;
}

// ---- Score bucketing -------------------------------------------------------

// Confluence score |net| is ordinal, not probabilistic. We bin it and let the
// data say what each bin is worth.
const SCORE_BINS = [
  { key: 's1', min: 0, max: 2.5 },
  { key: 's2', min: 2.5, max: 4 },
  { key: 's3', min: 4, max: 5.5 },
  { key: 's4', min: 5.5, max: 7 },
  { key: 's5', min: 7, max: Infinity },
];

function scoreBin(score) {
  const s = Math.abs(Number(score) || 0);
  const b = SCORE_BINS.find((x) => s >= x.min && s < x.max);
  return b ? b.key : 's1';
}

// ---- Fitting ---------------------------------------------------------------

function aggregate(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const ci = wilson(wins, n);
  // The gate asks a ONE-SIDED question: "is the true rate above the threshold?"
  // A two-sided 95% bound is the wrong tool for that and rejects genuine edges
  // needlessly, so a one-sided 90% bound is reported alongside for the decision.
  // The two-sided interval is still what gets displayed, since it is the honest
  // summary of uncertainty in both directions.
  const oneSided = wilson(wins, n, Z_ONE_SIDED_90);
  return {
    n,
    wins,
    winRate: n ? +((wins / n) * 100).toFixed(2) : null,
    ciLow: ci.low,
    ciHigh: ci.high,
    ciLow90: oneSided.low,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const out = {};
  for (const [k, v] of map) out[k] = aggregate(v);
  return out;
}

// Build a calibration model from resolved samples.
// Each sample: { setup, interval, direction, score, win }
function fit(samples, opts = {}) {
  const minSample = opts.minSample || DEFAULT_MIN_SAMPLE;
  const rows = (samples || []).filter((s) => typeof s.win === 'boolean');
  return {
    version: 2,
    fittedAt: Date.now(),
    minSample,
    total: rows.length,
    global: aggregate(rows),
    byInterval: groupBy(rows, (r) => r.interval),
    bySetupInterval: groupBy(rows, (r) => `${r.setup}|${r.interval}`),
    bySetupIntervalScore: groupBy(rows, (r) => `${r.setup}|${r.interval}|${scoreBin(r.score)}`),
  };
}

// ---- Prediction ------------------------------------------------------------

// Hierarchical lookup: most specific bucket with enough samples wins.
// Returns { ready, probability, ciLow, ciHigh, n, source }.
function predict(model, ctx) {
  if (!model || !model.total) {
    return { ready: false, probability: null, ciLow: null, ciHigh: null, n: 0, source: 'niciun model calibrat' };
  }
  const minSample = model.minSample || DEFAULT_MIN_SAMPLE;
  const candidates = [
    { bucket: model.bySetupIntervalScore?.[`${ctx.setup}|${ctx.interval}|${scoreBin(ctx.score)}`], source: `${ctx.setup} · ${ctx.interval} · scor ${scoreBin(ctx.score)}` },
    { bucket: model.bySetupInterval?.[`${ctx.setup}|${ctx.interval}`], source: `${ctx.setup} · ${ctx.interval}` },
    { bucket: model.byInterval?.[ctx.interval], source: `toate setup-urile · ${ctx.interval}` },
    { bucket: model.global, source: 'global' },
  ];
  for (const c of candidates) {
    if (c.bucket && c.bucket.n >= minSample && c.bucket.winRate != null) {
      return {
        ready: true,
        probability: c.bucket.winRate,
        ciLow: c.bucket.ciLow,
        ciHigh: c.bucket.ciHigh,
        ciLow90: c.bucket.ciLow90,
        n: c.bucket.n,
        source: c.source,
      };
    }
  }
  const best = candidates.find((c) => c.bucket && c.bucket.n > 0);
  return {
    ready: false,
    probability: null,
    ciLow: null,
    ciHigh: null,
    n: best ? best.bucket.n : 0,
    source: `date insuficiente (nevoie de ${minSample} rezultate, am ${best ? best.bucket.n : 0})`,
  };
}

// ---- The actual trade/skip decision ---------------------------------------
//
// Deliberately conservative: it compares the LOWER bound of the confidence
// interval against break-even, not the point estimate. A raw 56% off 25 samples
// has a lower bound near 40% — that is not an edge, it is noise, and this gate
// refuses it. Being slow to say yes is the correct failure mode when the
// alternative is losing money.
function decide(prediction, payoutPct, opts = {}) {
  const marginPct = opts.marginPct != null ? opts.marginPct : 1.5; // required cushion
  const be = breakEvenWinRate(payoutPct);
  if (be == null) {
    return { trade: false, reason: 'payout invalid', breakEven: null };
  }
  if (!prediction || !prediction.ready) {
    return {
      trade: false,
      reason: prediction ? prediction.source : 'fără predicție calibrată',
      breakEven: be,
      needsData: true,
    };
  }
  const required = be + marginPct;
  // One-sided 90% lower bound: the appropriate bound for a directional threshold
  // test. Falls back to the two-sided bound if a caller supplies only that.
  const conservative = prediction.ciLow90 != null ? prediction.ciLow90 : prediction.ciLow;
  const ev = expectedValue(prediction.probability, payoutPct);
  const evConservative = expectedValue(conservative, payoutPct);
  const trade = conservative != null && conservative >= required;
  return {
    trade,
    breakEven: be,
    required: +required.toFixed(2),
    probability: prediction.probability,
    conservative,
    ev,
    evConservative,
    kelly: trade ? kellyFraction(conservative, payoutPct) : 0,
    n: prediction.n,
    source: prediction.source,
    reason: trade
      ? `probabilitate conservatoare ${conservative}% ≥ prag ${required.toFixed(1)}% (payout ${payoutPct}%)`
      : `probabilitate conservatoare ${conservative}% < prag ${required.toFixed(1)}% necesar la payout ${payoutPct}% — EV negativ, se sare`,
  };
}

// The inverse question, and the one that is actually useful at the screen.
//
// Payout on these contracts moves constantly and is quoted per symbol, so asking
// "is this payout good enough?" against a number typed into a config file is
// fragile. Inverting it is robust: given what the model can defend, state the
// payout the trade would need. The user then reads the live figure off MEXC and
// compares. No polling, no stale config, no assumption.
function requiredPayout(conservativeWinRatePct, marginPct = 1.5) {
  const p = Number(conservativeWinRatePct) - Number(marginPct);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (p >= 100) return 0;
  return +(((100 / p) - 1) * 100).toFixed(1);
}

module.exports = {
  breakEvenWinRate,
  requiredPayout,
  expectedValue,
  kellyFraction,
  wilson,
  vsCoinFlip,
  brierScore,
  reliability,
  scoreBin,
  SCORE_BINS,
  fit,
  predict,
  decide,
  DEFAULT_MIN_SAMPLE,
};
