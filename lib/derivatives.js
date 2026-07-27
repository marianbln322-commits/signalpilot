'use strict';

// Optional public MEXC perpetual-futures context. These variables are recorded
// for forward validation but deliberately do not change direction until enough
// historical observations exist to calibrate them out-of-sample.
const BASE = 'https://contract.mexc.com';
const history = new Map();

function contractSymbol(spotSymbol) {
  return String(spotSymbol).replace(/USDT$/i, '_USDT');
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body && body.success === false) throw new Error(body.message || 'MEXC contract API error');
  return body?.data ?? body;
}

function number(...values) {
  for (const value of values) {
    if (value == null || (typeof value === 'string' && value.trim() === '')) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function getDerivativesContext(spotSymbol) {
  const symbol = contractSymbol(spotSymbol);
  const [tickerResult, fundingResult] = await Promise.allSettled([
    fetchJson(`${BASE}/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`),
    fetchJson(`${BASE}/api/v1/contract/funding_rate/${encodeURIComponent(symbol)}`),
  ]);
  if (tickerResult.status === 'rejected' && fundingResult.status === 'rejected') {
    throw new Error(`derivatives ${symbol}: ticker ${tickerResult.reason?.message}; funding ${fundingResult.reason?.message}`);
  }

  const tickerRaw = tickerResult.status === 'fulfilled' ? tickerResult.value : null;
  const ticker = Array.isArray(tickerRaw) ? tickerRaw.find((x) => x.symbol === symbol) || tickerRaw[0] : tickerRaw;
  const funding = fundingResult.status === 'fulfilled' ? fundingResult.value : null;
  const lastPrice = number(ticker?.lastPrice, ticker?.last);
  const fairPrice = number(ticker?.fairPrice);
  const indexPrice = number(ticker?.indexPrice);
  const openInterest = number(ticker?.holdVol, ticker?.openInterest);
  const fundingRate = number(funding?.fundingRate, ticker?.fundingRate);
  const now = Date.now();

  const snapshots = history.get(symbol) || [];
  snapshots.push({ ts: now, openInterest });
  while (snapshots.length > 120 || (snapshots[0] && now - snapshots[0].ts > 15 * 60 * 1000)) snapshots.shift();
  history.set(symbol, snapshots);
  const targetAgeMs = 5 * 60 * 1000;
  const candidates = snapshots.filter((s) => s.ts < now && Number.isFinite(s.openInterest));
  const closest = candidates.sort((a, b) =>
    Math.abs(now - a.ts - targetAgeMs) - Math.abs(now - b.ts - targetAgeMs)
  )[0];
  const baseline = closest && Math.abs(now - closest.ts - targetAgeMs) <= 2 * 60 * 1000 ? closest : null;
  const oiChangePct = baseline && openInterest != null && baseline.openInterest !== 0
    ? ((openInterest - baseline.openInterest) / baseline.openInterest) * 100
    : null;
  const basisReference = indexPrice ?? fairPrice;
  const basisBps = lastPrice != null && basisReference
    ? ((lastPrice - basisReference) / basisReference) * 10000
    : null;

  return {
    symbol,
    lastPrice,
    fairPrice,
    indexPrice,
    openInterest,
    oiChangePct: oiChangePct != null ? +oiChangePct.toFixed(4) : null,
    oiWindowSec: baseline ? Math.round((now - baseline.ts) / 1000) : null,
    fundingRate,
    basisBps: basisBps != null ? +basisBps.toFixed(2) : null,
    observedAt: now,
    calibrated: false,
  };
}

module.exports = { getDerivativesContext, contractSymbol, BASE };
