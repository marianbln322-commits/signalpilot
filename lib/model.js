'use strict';

// ============================================================================
// model.js — regularised logistic regression, no dependencies.
//
// WHY LOGISTIC REGRESSION AND NOT SOMETHING FANCIER
// The task is to output P(up) — a probability, not a label — because the EV gate
// compares a probability against the break-even a payout imposes. Logistic
// regression optimises exactly that (log loss), and its coefficients are
// readable: you can see which inputs the data actually rewarded, and whether the
// sign matches the story someone told about the setup.
//
// It is also the honest choice at this signal-to-noise ratio. With a target that
// is ~50/50 and features that are mostly noise, a gradient-boosted forest will
// happily memorise the training set and report a beautiful in-sample number. A
// linear model with L2 has far less room to fool us, and if a linear model finds
// nothing, that is strong evidence there is nothing easy to find.
//
// Standardisation statistics are computed on TRAINING DATA ONLY and reused for
// test data. Standardising over the whole set first is a classic subtle leak: the
// test set influences the transform, and out-of-sample results come out flattered.
// ============================================================================

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function standardizer(X) {
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= X.length;
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / Math.max(1, X.length - 1)) || 1;
  return {
    mean,
    std,
    apply: (row) => row.map((v, j) => (v - mean[j]) / std[j]),
  };
}

// Adam. Plain gradient descent needs per-feature learning-rate babysitting when
// inputs have different effective scales even after standardisation.
function fit(X, y, opts = {}) {
  const l2 = opts.l2 != null ? opts.l2 : 1.0;
  const epochs = opts.epochs || 300;
  const lr = opts.lr || 0.05;
  const batch = opts.batch || 256;
  const seed = opts.seed || 1;

  const sc = standardizer(X);
  const Z = X.map(sc.apply);
  const n = Z.length;
  const d = Z[0].length;

  let w = new Array(d).fill(0);
  let b = 0;
  const mW = new Array(d).fill(0); const vW = new Array(d).fill(0);
  let mB = 0; let vB = 0;
  const beta1 = 0.9; const beta2 = 0.999; const eps = 1e-8;
  let step = 0;

  // Deterministic shuffling so a run is reproducible.
  let rs = seed;
  const rnd = () => {
    rs = (rs * 1103515245 + 12345) & 0x7fffffff;
    return rs / 0x7fffffff;
  };
  const idx = [...Array(n).keys()];

  for (let e = 0; e < epochs; e++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (let s = 0; s < n; s += batch) {
      const chunk = idx.slice(s, s + batch);
      const gW = new Array(d).fill(0);
      let gB = 0;
      for (const k of chunk) {
        let z = b;
        const row = Z[k];
        for (let j = 0; j < d; j++) z += w[j] * row[j];
        const err = sigmoid(z) - (y[k] ? 1 : 0);
        for (let j = 0; j < d; j++) gW[j] += err * row[j];
        gB += err;
      }
      const m = chunk.length;
      step++;
      for (let j = 0; j < d; j++) {
        // L2 is applied to weights only, never to the intercept: penalising the
        // intercept would drag the predicted base rate away from the truth.
        //
        // The data gradient here is a MEAN over the minibatch, i.e. an estimate of
        // (1/n)·Σ∇loss. The penalty must therefore be λ·w, not λ·w/n — dividing by
        // n again made the stated `l2` roughly n times weaker than it claimed, so
        // raising it from 1 to 200 changed almost nothing and the model quietly
        // overfitted while appearing regularised.
        const g = gW[j] / m + l2 * w[j];
        mW[j] = beta1 * mW[j] + (1 - beta1) * g;
        vW[j] = beta2 * vW[j] + (1 - beta2) * g * g;
        w[j] -= lr * (mW[j] / (1 - beta1 ** step)) / (Math.sqrt(vW[j] / (1 - beta2 ** step)) + eps);
      }
      const gb = gB / m;
      mB = beta1 * mB + (1 - beta1) * gb;
      vB = beta2 * vB + (1 - beta2) * gb * gb;
      b -= lr * (mB / (1 - beta1 ** step)) / (Math.sqrt(vB / (1 - beta2 ** step)) + eps);
    }
  }

  return { w, b, mean: sc.mean, std: sc.std, d, l2, epochs, trainedOn: n };
}

function predictOne(model, row) {
  let z = model.b;
  for (let j = 0; j < model.d; j++) z += model.w[j] * ((row[j] - model.mean[j]) / model.std[j]);
  return sigmoid(z);
}

const predict = (model, X) => X.map((r) => predictOne(model, r));

// ---- Metrics ---------------------------------------------------------------

// Brier score: mean squared error of the probabilities. 0.25 is what you get by
// always saying 50%, so anything >= 0.25 means the model adds nothing.
function brier(p, y) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += (p[i] - (y[i] ? 1 : 0)) ** 2;
  return s / p.length;
}

function logLoss(p, y) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.max(1e-12, Math.min(1 - 1e-12, p[i]));
    s += y[i] ? -Math.log(q) : -Math.log(1 - q);
  }
  return s / p.length;
}

// Accuracy when the model commits to a side, plus how often it commits.
// The gate only ever acts on confident predictions, so overall accuracy is the
// wrong headline: what matters is accuracy on the subset actually traded.
function accuracyAtThreshold(p, y, threshold = 0.5) {
  let n = 0; let correct = 0;
  for (let i = 0; i < p.length; i++) {
    const conf = Math.abs(p[i] - 0.5) + 0.5;
    if (conf < threshold) continue;
    n++;
    const up = p[i] > 0.5;
    if (up === !!y[i]) correct++;
  }
  return { n, correct, accuracy: n ? correct / n : null, coverage: n / p.length };
}

// Which inputs did the data actually reward? Coefficients are on standardised
// features, so magnitudes are directly comparable.
function topWeights(model, names, k = 12) {
  return names
    .map((name, j) => ({ name, weight: +model.w[j].toFixed(4) }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, k);
}

module.exports = {
  fit, predict, predictOne, standardizer,
  brier, logLoss, accuracyAtThreshold, topWeights, sigmoid,
};
