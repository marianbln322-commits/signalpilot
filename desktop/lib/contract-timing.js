'use strict';

const MINUTE_MS = 60_000;

function assertFiniteTime(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite timestamp`);
}

function assertHorizon(horizonMin) {
  if (!Number.isInteger(horizonMin) || horizonMin <= 0) throw new Error('horizonMin must be a positive integer');
}

function firstMinuteOpenStrictlyAfter(availableAt) {
  assertFiniteTime(availableAt, 'availableAt');
  return (Math.floor(availableAt / MINUTE_MS) + 1) * MINUTE_MS;
}

function contractBoundaries(availableAt, horizonMin) {
  assertHorizon(horizonMin);
  const entryOpenTime = firstMinuteOpenStrictlyAfter(availableAt);
  return {
    availableAt,
    entryOpenTime,
    finalMinuteOpenTime: entryOpenTime + (horizonMin - 1) * MINUTE_MS,
    expiryCloseTime: entryOpenTime + horizonMin * MINUTE_MS - 1,
    horizonMin,
  };
}

function findExactOpen(candles, openTime) {
  return (candles || []).find((candle) => candle.openTime === openTime) || null;
}

function findExactClose(candles, closeTime) {
  return (candles || []).find((candle) => candle.closeTime === closeTime) || null;
}

function boundaryState(candles, boundaries) {
  const ordered = [...(candles || [])].sort((a, b) => a.openTime - b.openTime);
  const latest = ordered[ordered.length - 1] || null;
  const entry = findExactOpen(ordered, boundaries.entryOpenTime);
  if (!entry && latest && latest.openTime > boundaries.entryOpenTime) {
    return { status: 'invalid', reason: 'ENTRY_BOUNDARY_MISSING', entry: null, exit: null };
  }
  if (!entry) return { status: 'pending-entry', reason: null, entry: null, exit: null };
  const exit = findExactClose(ordered, boundaries.expiryCloseTime);
  if (!exit && latest && latest.closeTime > boundaries.expiryCloseTime) {
    return { status: 'invalid', reason: 'EXPIRY_BOUNDARY_MISSING', entry, exit: null };
  }
  if (!exit) return { status: 'pending-expiry', reason: null, entry, exit: null };
  return { status: 'complete', reason: null, entry, exit };
}

module.exports = {
  MINUTE_MS,
  firstMinuteOpenStrictlyAfter,
  contractBoundaries,
  findExactOpen,
  findExactClose,
  boundaryState,
};
