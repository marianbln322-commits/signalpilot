'use strict';

// ============================================================================
// binance.js — DEEP HISTORY source used ONLY for backtesting.
// MEXC's public klines endpoint ignores startTime/endTime and serves only the
// most recent ~500 bars, so it cannot support a meaningful backtest. The public
// Binance data mirror (data-api.binance.vision) honors startTime and provides
// deep history. BTC/ETH prices on MEXC vs Binance track within a few bps, so it
// is a valid proxy for evaluating strategy edge. Live signals still use MEXC.
// ============================================================================

const BASE = 'https://data-api.binance.vision';

async function fetchHistory(symbol, interval = '5m', days = 15, maxPerReq = 1000, endTimeMs = null) {
  const end = endTimeMs || Date.now();
  let start = end - days * 86400 * 1000;
  const all = [];
  let guard = 0;
  while (start < end && guard < 120) {
    guard++;
    const url = `${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${maxPerReq}&startTime=${start}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) break;
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const r of raw) {
      all.push({
        openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
        low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
        closeTime: Number(r[6]), quoteVolume: Number(r[7]),
      });
    }
    const lastOpen = Number(raw[raw.length - 1][0]);
    if (lastOpen <= start) break;
    start = lastOpen + 1;
    if (raw.length < maxPerReq) break;
  }
  // Trim anything past the requested end window (when backtesting older ranges).
  const filtered = all.filter((c) => c.openTime <= end);
  const seenF = new Map();
  for (const c of filtered) seenF.set(c.openTime, c);
  return [...seenF.values()].sort((a, b) => a.openTime - b.openTime);
}

module.exports = { fetchHistory, BASE };
