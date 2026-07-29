'use strict';

// ============================================================================
// priceTape.js — a short rolling tape of observed prices per symbol, so outcomes
// can be settled on a TIME-WEIGHTED AVERAGE rather than one instantaneous tick.
//
// WHY THIS MATTERS MORE THAN IT LOOKS
// MEXC states that Up/Down prediction settlement prices are determined from a
// composite real-time index combined with a time-weighted average price:
// https://blog.mexc.com/press-release/mexc-launches-up-or-down-prediction-feature/
//
// The journal previously graded every signal by calling /ticker/price once at
// expiry and comparing that single tick to the entry price. So the app was
// scoring itself on a different scoreboard from the one that pays out. The gap
// is not cosmetic:
//
//   - A wick in the final seconds flips a single-tick comparison but barely
//     moves a TWAP, so "wins" were being recorded that the contract would have
//     settled as losses (and the reverse).
//   - TWAP systematically damps end-of-window spikes, which is exactly where
//     10-minute predictions are decided.
//
// Averaging over a window is a much closer approximation. It is still an
// approximation: the exact composite index weights are not published, and this
// reads a single venue's spot price. That limitation is stated rather than
// hidden — but approximating the right quantity beats measuring the wrong one
// precisely.
// ============================================================================

const MAX_AGE_MS = 15 * 60 * 1000; // keep 15 min of history; windows are <= 30 min

class PriceTape {
  constructor(maxAgeMs = MAX_AGE_MS) {
    this.maxAgeMs = maxAgeMs;
    this.tapes = new Map(); // symbol -> [{ ts, price }]
  }

  push(symbol, price, ts = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    if (!this.tapes.has(symbol)) this.tapes.set(symbol, []);
    const tape = this.tapes.get(symbol);
    tape.push({ ts, price });
    const cutoff = ts - this.maxAgeMs;
    while (tape.length && tape[0].ts < cutoff) tape.shift();
  }

  latest(symbol) {
    const tape = this.tapes.get(symbol);
    return tape && tape.length ? tape[tape.length - 1] : null;
  }

  // Time-weighted average price over [fromTs, toTs].
  //
  // Each sample is weighted by how long it stood as the most recent observation,
  // which is what makes this time-weighted rather than a plain mean of ticks —
  // sampling is not perfectly regular, so a plain mean would over-weight bursts.
  twap(symbol, fromTs, toTs) {
    const tape = this.tapes.get(symbol);
    if (!tape || !tape.length) return null;
    const inWindow = tape.filter((s) => s.ts >= fromTs && s.ts <= toTs);
    if (!inWindow.length) return null;

    if (inWindow.length === 1) {
      return { price: inWindow[0].price, samples: 1, spanMs: 0, method: 'single-sample' };
    }

    let weighted = 0;
    let totalMs = 0;
    for (let i = 0; i < inWindow.length - 1; i++) {
      const dt = inWindow[i + 1].ts - inWindow[i].ts;
      if (dt <= 0) continue;
      weighted += inWindow[i].price * dt;
      totalMs += dt;
    }
    // The final sample holds until the end of the window.
    const tailDt = Math.max(0, toTs - inWindow[inWindow.length - 1].ts);
    if (tailDt > 0) {
      weighted += inWindow[inWindow.length - 1].price * tailDt;
      totalMs += tailDt;
    }
    if (totalMs <= 0) {
      const mean = inWindow.reduce((a, s) => a + s.price, 0) / inWindow.length;
      return { price: mean, samples: inWindow.length, spanMs: 0, method: 'mean-fallback' };
    }
    return {
      price: weighted / totalMs,
      samples: inWindow.length,
      spanMs: totalMs,
      method: 'twap',
    };
  }

  stats(symbol) {
    const tape = this.tapes.get(symbol);
    if (!tape || !tape.length) return { samples: 0 };
    return {
      samples: tape.length,
      oldest: tape[0].ts,
      newest: tape[tape.length - 1].ts,
      spanSec: Math.round((tape[tape.length - 1].ts - tape[0].ts) / 1000),
    };
  }
}

module.exports = { PriceTape, MAX_AGE_MS };
