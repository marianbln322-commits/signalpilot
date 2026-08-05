'use strict';

function wilson95(wins, n) {
  if (!n) return { low: null, high: null };
  const z = 1.959963984540054;
  const p = wins / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n) / denominator;
  return {
    low: Number((Math.max(0, center - margin) * 100).toFixed(1)),
    high: Number((Math.min(1, center + margin) * 100).toFixed(1)),
  };
}

function qualityBand(quality) {
  const value = Number(quality);
  if (!Number.isFinite(value) || value < 60) return '0-59';
  if (value < 70) return '60-69';
  if (value < 80) return '70-79';
  if (value < 90) return '80-89';
  return '90-100';
}

function bucketKey(horizonMin, direction, quality) {
  return `${Number(horizonMin)}m|${direction}|${qualityBand(quality)}`;
}

function buildCalibration(records) {
  const groups = new Map();
  for (const record of records || []) {
    if (!['UP', 'DOWN'].includes(record.direction) || typeof record.win !== 'boolean') continue;
    const key = bucketKey(record.horizonMin, record.direction, record.quality);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const buckets = {};
  for (const [key, values] of groups) {
    const wins = values.filter((value) => value.win).length;
    buckets[key] = {
      key,
      horizonMin: Number(values[0].horizonMin),
      direction: values[0].direction,
      qualityBand: qualityBand(values[0].quality),
      n: values.length,
      wins,
      winRate: Number((wins / values.length * 100).toFixed(1)),
      wilson95: wilson95(wins, values.length),
    };
  }
  return { dimensions: ['horizonMin', 'direction', 'qualityBand'], buckets };
}

function chooseEstimate({ verdict, horizonMin, quality, forward, backtest, forwardMinimum = 30, backtestMinimum = 50 }) {
  if (!['UP', 'DOWN'].includes(verdict)) return { status: 'not-estimated', reason: 'WAIT' };
  const key = bucketKey(horizonMin, verdict, quality);
  const forwardBucket = forward && forward.buckets ? forward.buckets[key] : null;
  const backtestBucket = backtest && backtest.buckets ? backtest.buckets[key] : null;
  if (forwardBucket && forwardBucket.n >= forwardMinimum) {
    return { status: 'estimated', source: 'forward', bucket: forwardBucket };
  }
  if (backtestBucket && backtestBucket.n >= backtestMinimum) {
    return { status: 'estimated', source: 'backtest-proxy-in-sample', bucket: backtestBucket };
  }
  const samples = [forwardBucket, backtestBucket].filter(Boolean);
  const best = samples.sort((a, b) => b.n - a.n)[0] || null;
  return { status: 'insufficient', key, n: best ? best.n : 0, forwardN: forwardBucket ? forwardBucket.n : 0, backtestN: backtestBucket ? backtestBucket.n : 0 };
}

module.exports = { qualityBand, bucketKey, buildCalibration, chooseEstimate };
