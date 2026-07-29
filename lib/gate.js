'use strict';

// ============================================================================
// gate.js — the single decision point that turns a forecast into an action.
//
// Two distinct signal levels, never mixed:
//   PAPER  = a valid technical read (candles + indicators + structure). Useful
//            immediately, journalled and scored, but explicitly NOT validated.
//   TRADE  = the same read AFTER the exact symbol+direction+horizon cohort has
//            enough settled forward results and clears every quality floor.
//
// Every threshold is applied on raw (unrounded) empirical values so a display
// rounding can never unlock execution.
// ============================================================================

function evaluateForecastGate(forecast, options) {
  const {
    payoutPct,
    minWinRate,
    minLowerBound,
    minSamples,
    allowPaper = true,
  } = options;

  const breakEven = 1 / (1 + payoutPct / 100);
  const qualityFloor = minWinRate / 100;
  const reliabilityFloor = minLowerBound / 100;
  const sampleSize = Number.isInteger(forecast.calibrationSampleSize) ? forecast.calibrationSampleSize : 0;

  const result = {
    action: 'WAIT',
    signalClass: null,
    suppressed: forecast.suppressed || null,
    breakEven: +breakEven.toFixed(4),
    qualityFloor: +qualityFloor.toFixed(4),
    reliabilityFloor: +reliabilityFloor.toFixed(4),
    requiredProbability: +Math.max(breakEven, qualityFloor).toFixed(4),
    payoutPct,
    expectedValue: null,
    calibrationSampleSize: sampleSize,
    calibrationRequired: minSamples,
    calibrationRemaining: Math.max(0, minSamples - sampleSize),
  };

  // Stale exchange data can never produce any signal level.
  if (forecast.inputFresh === false) {
    result.suppressed = `date MEXC neactualizate pe: ${(forecast.staleTimeframes || []).join(', ')}`;
    return result;
  }

  const calibrated = forecast.calibrated && Number.isFinite(forecast.confidence);
  if (!calibrated) {
    if (allowPaper && forecast.setupValid && forecast.directie !== 'NEUTRU') {
      result.action = 'PAPER';
      result.signalClass = 'technical-paper';
      result.suppressed = forecast.suppressed ||
        `semnal tehnic PAPER — validare ${sampleSize}/${minSamples}; nu este TRADE validat`;
      return result;
    }
    result.suppressed = forecast.suppressed || `validare în curs ${sampleSize}/${minSamples}`;
    return result;
  }

  result.expectedValue = +(forecast.confidence * (payoutPct / 100) - (1 - forecast.confidence)).toFixed(4);

  if (!forecast.setupValid) {
    result.suppressed = forecast.suppressed || 'setup tehnic incomplet';
  } else if (forecast.suppressed) {
    // An upstream veto (learning or technique tuning) stays authoritative.
  } else if (sampleSize < minSamples) {
    result.suppressed = `eșantion insuficient: ${sampleSize}/${minSamples}`;
  } else if (forecast.confidence <= breakEven) {
    result.suppressed = `sub break-even: ${(forecast.confidence * 100).toFixed(1)}% ≤ ${(breakEven * 100).toFixed(1)}%`;
  } else if (forecast.confidence < qualityFloor) {
    result.suppressed = `sub pragul de calitate: ${(forecast.confidence * 100).toFixed(1)}% < ${minWinRate}%`;
  } else if (!Number.isFinite(forecast.reliabilityLowerBound) || forecast.reliabilityLowerBound < reliabilityFloor) {
    const bound = Number.isFinite(forecast.reliabilityLowerBound)
      ? `${(forecast.reliabilityLowerBound * 100).toFixed(1)}%`
      : 'indisponibilă';
    result.suppressed = `eșantion încă fragil: limita conservatoare ${bound} < ${minLowerBound}%`;
  } else {
    result.action = 'TRADE';
    result.signalClass = 'validated-trade';
    result.suppressed = null;
    return result;
  }

  // A calibrated forecast that fails a validation floor can still be shown as a
  // clearly labelled technical signal, never as a validated trade.
  if (allowPaper && forecast.setupValid && forecast.directie !== 'NEUTRU') {
    result.action = 'PAPER';
    result.signalClass = 'technical-paper';
  }
  return result;
}

module.exports = { evaluateForecastGate };
