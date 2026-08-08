'use strict';

// ============================================================================
// sizing.js — how much to stake, derived from the measured edge.
//
// A professional does not size by how confident a signal FEELS; they size by
// how large the edge is and how well it is measured. Two signals both labelled
// "high confidence" deserve very different stakes if one rests on 400 resolved
// outcomes and the other on 31.
//
// The formula is Kelly for a binary payout b:
//
//     f* = (p·(1+b) − 1) / b
//
// f* is the fraction of bankroll that maximises long-run growth. Three things
// are done to it before it is ever shown to a user:
//
// 1. It is computed from the CONSERVATIVE probability (lower confidence bound),
//    never the point estimate. Kelly is extremely sensitive to overestimating p:
//    overbetting compounds toward ruin while underbetting only costs some upside.
//
// 2. It is multiplied by a fraction (default 0.25). Quarter-to-half Kelly is
//    standard practice precisely because the true p is never known exactly.
//
// 3. It is hard-capped as a percentage of bankroll, regardless of what the maths
//    suggests. A binary contract cannot be stopped out — there is no exit at a
//    better price, so a single position is all-or-nothing on that stake.
//
// The result is that "large stake" here means something like 3-5% of bankroll,
// not 50%. Any tool that suggests staking half your account on a 10-minute
// price prediction is not sizing, it is gambling.
// ============================================================================

const cal = require('./calibration');

const DEFAULTS = {
  bankroll: 1000,
  kellyFractionMultiplier: 0.25, // quarter Kelly
  maxStakePct: 5,                // hard ceiling per position
  minStakePct: 0.5,              // below this it is not worth the fees/attention
  // Sample-size shrinkage: an edge measured on few outcomes is discounted.
  fullTrustSamples: 200,
};

// Tiers exist for at-a-glance emphasis in the UI. They are driven by the SIZE OF
// THE EDGE (conservative probability above break-even), not by the raw score.
const TIERS = [
  { key: 'maxima', label: 'MAXIMĂ',  minEdgePct: 8 },
  { key: 'mare',   label: 'MARE',    minEdgePct: 4 },
  { key: 'medie',  label: 'MEDIE',   minEdgePct: 2 },
  { key: 'mica',   label: 'MICĂ',    minEdgePct: 0 },
];

function tierFor(edgePct) {
  return TIERS.find((t) => edgePct >= t.minEdgePct) || TIERS[TIERS.length - 1];
}

// Confidence in the ESTIMATE itself, from sample size. Ranges 0..1 and is used
// to shrink the stake when the underlying statistics are thin.
function sampleTrust(n, fullTrustSamples) {
  if (!n || n <= 0) return 0;
  return Math.min(1, Math.sqrt(n / fullTrustSamples));
}

// Compute a recommended stake for a gated signal.
//
// `gate` is the object returned by calibration.decide(): it already contains the
// conservative probability and whether the trade clears break-even.
function recommend(gate, payoutPct, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const bankroll = Number(cfg.bankroll) > 0 ? Number(cfg.bankroll) : DEFAULTS.bankroll;

  // No stake without an approved, measured edge. This is not conservatism for
  // its own sake: sizing off an unknown probability is undefined, not risky.
  if (!gate || !gate.trade || gate.conservative == null) {
    return {
      stake: 0,
      pctOfBankroll: 0,
      tier: null,
      tierLabel: 'FĂRĂ POZIȚIE',
      edgePct: null,
      kellyFull: null,
      kellyUsed: null,
      trust: 0,
      reason: gate && gate.needsData
        ? 'nu există probabilitate măsurată — nu se poate dimensiona nimic'
        : 'poarta EV nu a aprobat semnalul',
      warnings: [],
    };
  }

  const p = gate.conservative;           // conservative, not optimistic
  const be = gate.breakEven;
  const edgePct = +(p - be).toFixed(2);  // percentage points above break-even

  const kellyFull = cal.kellyFraction(p, payoutPct);          // 0..1
  const trust = sampleTrust(gate.n, cfg.fullTrustSamples);
  const kellyUsed = kellyFull * cfg.kellyFractionMultiplier * trust;

  let pct = kellyUsed * 100;
  const warnings = [];

  if (pct > cfg.maxStakePct) {
    warnings.push(`Kelly sugera ${pct.toFixed(1)}% din capital; plafonat la ${cfg.maxStakePct}%. Un contract binar nu poate fi închis în pierdere parțială.`);
    pct = cfg.maxStakePct;
  }
  if (pct < cfg.minStakePct) {
    return {
      stake: 0,
      pctOfBankroll: 0,
      tier: 'mica',
      tierLabel: 'PREA MIC',
      edgePct,
      kellyFull: +(kellyFull * 100).toFixed(2),
      kellyUsed: +(kellyUsed * 100).toFixed(2),
      trust: +trust.toFixed(2),
      reason: `edge-ul (${edgePct} puncte peste pragul de rentabilitate) justifică doar ${pct.toFixed(2)}% din capital — sub minimul de ${cfg.minStakePct}%, nu merită intrat`,
      warnings,
    };
  }

  if (trust < 0.5) {
    warnings.push(`Statistică subțire: ${gate.n} rezultate. Miza e redusă proporțional (încredere ${(trust * 100).toFixed(0)}%). Va crește pe măsură ce jurnalul se umple.`);
  }

  const tier = tierFor(edgePct);
  const stake = +((pct / 100) * bankroll).toFixed(2);

  return {
    stake,
    pctOfBankroll: +pct.toFixed(2),
    tier: tier.key,
    tierLabel: tier.label,
    edgePct,
    kellyFull: +(kellyFull * 100).toFixed(2),
    kellyUsed: +(kellyUsed * 100).toFixed(2),
    trust: +trust.toFixed(2),
    bankroll,
    reason: `probabilitate prudentă ${p}% vs prag ${be}% ⇒ edge ${edgePct} puncte · Kelly integral ${(kellyFull * 100).toFixed(1)}% × ${cfg.kellyFractionMultiplier} × încredere ${(trust * 100).toFixed(0)}%`,
    warnings,
  };
}

module.exports = { recommend, tierFor, sampleTrust, TIERS, DEFAULTS };
