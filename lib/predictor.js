'use strict';

// ============================================================================
// predictor.js — the live path for a trained model.
//
// This is the piece that was missing. tools/train.js could learn weights and
// tools/analyze-positions.js could measure outcomes, but nothing connected a
// trained model to a running signal: engine.js was still scoring with the
// hand-written constants. This module closes that gap.
//
// THE IMPORTANT DESIGN DECISION
// The raw logistic output is never handed to the EV gate. A model can output 0.58
// while predictions in that band turned out right 50% of the time on data it had
// not seen. Acting on 0.58 would be acting on a number nobody verified.
//
// So each model file carries a reliability table built during walk-forward
// validation: for every confidence band, how often that band was ACTUALLY correct
// out-of-sample, with a confidence interval computed on independent samples. The
// live path takes the model's output, finds its band, and returns the measured
// accuracy and its lower bound. The gate then compares that against the
// break-even the payout imposes.
//
// The consequence is deliberate: if a band was measured at 50%, the gate refuses,
// no matter how confident the model sounds. The model proposes; the measurement
// decides.
// ============================================================================

const fs = require('fs');
const path = require('path');
const features = require('./features');
const model = require('./model');

const MODELS_DIR = path.join(__dirname, '..', 'models');

// Load every models/<SYMBOL>-<H>m.json into a lookup keyed `SYMBOL|H`.
function loadAll(dir = MODELS_DIR) {
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out; // no models yet — the caller must handle that, not crash
  }
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!m || !Array.isArray(m.names) || !Array.isArray(m.w)) continue;
      const key = `${String(m.symbol).toUpperCase()}|${m.horizonMin}`;
      out[key] = m;
    } catch { /* skip unreadable file */ }
  }
  return out;
}

function bandFor(m, confidence) {
  if (!Array.isArray(m.reliability)) return null;
  return m.reliability.find((r) => confidence >= r.lo && confidence < r.hi) || null;
}

// Predict for one symbol/horizon from CLOSED candles.
//
// Returns the shape lib/calibration.js `decide()` expects, so the existing gate
// and sizing work unchanged:
//   { ready, probability, ciLow, ciHigh, ciLow90, n, source, direction, raw }
function predict(models, symbol, horizonMin, mtfClosed, opts = {}) {
  const minSample = opts.minSample != null ? opts.minSample : 30;
  const key = `${String(symbol).toUpperCase()}|${horizonMin}`;
  const m = models[key];
  if (!m) {
    return {
      ready: false, probability: null, ciLow: null, ciHigh: null, ciLow90: null, n: 0,
      source: `niciun model antrenat pentru ${symbol} pe ${horizonMin} min ` +
        '(rulează tools/train.js --save)',
      direction: null, raw: null,
    };
  }

  const f = features.extract(mtfClosed);
  if (!f) {
    return {
      ready: false, probability: null, ciLow: null, ciHigh: null, ciLow90: null, n: 0,
      source: 'context insuficient pentru features (prea puține bare închise)',
      direction: null, raw: null,
    };
  }

  // The saved feature order is authoritative. If the feature set changed since the
  // model was fitted, refuse rather than silently scoring a mismatched vector.
  const live = features.featureNames(f);
  if (live.length !== m.names.length || m.names.some((k, j) => k !== live[j])) {
    return {
      ready: false, probability: null, ciLow: null, ciHigh: null, ciLow90: null, n: 0,
      source: `modelul a fost antrenat pe ${m.names.length} features, acum sunt ${live.length}` +
        ' — reantrenează după modificarea features-urilor',
      direction: null, raw: null,
    };
  }

  const raw = model.predictOne(m, features.vectorize(f, m.names));
  const direction = raw > 0.5 ? 'UP' : 'DOWN';
  const confidence = Math.max(raw, 1 - raw);
  const band = bandFor(m, confidence);

  if (!band || !band.n || band.n < minSample || band.accuracy == null) {
    return {
      ready: false,
      probability: null, ciLow: null, ciHigh: null, ciLow90: null,
      n: band ? band.n : 0,
      source: `banda de încredere ${confidence.toFixed(3)} are doar ` +
        `${band ? band.n : 0} rezultate independente măsurate (nevoie de ${minSample})`,
      direction, raw: +raw.toFixed(4),
    };
  }

  return {
    ready: true,
    // The MEASURED accuracy of this band, not the model's own claim.
    probability: band.accuracy,
    ciLow: band.ciLow,
    ciHigh: band.ciHigh,
    ciLow90: band.ciLow90,
    n: band.n,
    source: `model ${m.symbol} ${m.horizonMin}min · bandă ${band.lo.toFixed(2)}–` +
      `${band.hi >= 1 ? '1.00' : band.hi.toFixed(2)} · ${band.n} rezultate out-of-sample`,
    direction,
    raw: +raw.toFixed(4),
    modelFittedAt: m.fittedAt,
  };
}

// What the UI needs to show about what is loaded.
function summary(models) {
  const rows = Object.entries(models).map(([key, m]) => {
    const usable = (m.reliability || []).filter((r) => r.n >= 30);
    const best = usable.reduce((a, r) => (a && a.ciLow90 >= r.ciLow90 ? a : r), null);
    return {
      key,
      symbol: m.symbol,
      horizonMin: m.horizonMin,
      features: m.names.length,
      trainedOn: m.trainedOn,
      fittedAt: m.fittedAt,
      bands: usable.length,
      bestBandCiLow90: best ? best.ciLow90 : null,
    };
  });
  return { count: rows.length, models: rows };
}

module.exports = { loadAll, predict, summary, MODELS_DIR, bandFor };
