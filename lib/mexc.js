'use strict';

// ============================================================================
// mexc.js — MEXC spot public market-data feed.
// Uses the keyless REST klines endpoint (Binance-compatible). We poll instead
// of using the protobuf WebSocket: for 10/30-min decisions, a few seconds of
// freshness is more than enough and polling is far more robust.
//
// Kline row format: [openTime, open, high, low, close, volume, closeTime, quoteVolume]
// Symbols use no underscore at spot v3, e.g. BTCUSDT, ETHUSDT.
// Valid native intervals used here: 1m, 5m, 15m, 30m, 60m. The 3m series
// is deterministically aggregated from exchange 1m candles in this module.
// ============================================================================

const BASE = 'https://api.mexc.com';
const REQUEST_TIMEOUT_MS = 8000;

const VALID_INTERVALS = new Set(['1m', '5m', '15m', '30m', '60m', '4h', '1d']);

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`MEXC request timeout after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Build an exchange-aligned synthetic timeframe from real 1m MEXC candles.
// MEXC Spot does not need to expose a native 3m endpoint: grouping is anchored
// to Unix/UTC boundaries and preserves real OHLCV without interpolation.
function aggregateCandles(candles, minutes = 3, { includeIncomplete = false } = {}) {
  if (!Array.isArray(candles) || !Number.isInteger(minutes) || minutes < 2) return [];
  const minuteMs = 60 * 1000;
  const bucketMs = minutes * minuteMs;
  const buckets = new Map();
  for (const candle of candles) {
    if (!candle || !Number.isFinite(candle.openTime)) continue;
    const bucketOpen = Math.floor(candle.openTime / bucketMs) * bucketMs;
    if (!buckets.has(bucketOpen)) buckets.set(bucketOpen, []);
    buckets.get(bucketOpen).push(candle);
  }

  const out = [];
  for (const [openTime, rows] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => a.openTime - b.openTime);
    const expected = Array.from({ length: minutes }, (_, index) => openTime + index * minuteMs);
    const complete = rows.length === minutes && expected.every((ts, index) => rows[index].openTime === ts);
    if (!complete && !includeIncomplete) continue;
    const first = rows[0];
    const last = rows[rows.length - 1];
    out.push({
      openTime,
      open: first.open,
      high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)),
      close: last.close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
      closeTime: complete ? openTime + bucketMs - 1 : last.closeTime,
      quoteVolume: rows.reduce((sum, row) => sum + (Number.isFinite(row.quoteVolume) ? row.quoteVolume : 0), 0),
      complete,
      derivedFrom: '1m',
    });
  }
  return out;
}

async function fetchKlines(symbol, interval = '15m', limit = 200) {
  if (!VALID_INTERVALS.has(interval)) {
    throw new Error(`Invalid interval "${interval}". Use one of: ${[...VALID_INTERVALS].join(', ')}`);
  }
  const url = `${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MEXC klines ${symbol} ${interval} -> HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected klines response for ${symbol}: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return raw.map((r) => ({
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: Number(r[6]),
    quoteVolume: Number(r[7]),
  }));
}

// Fetch a long history by paginating backwards with endTime.
// MEXC returns up to ~500 rows per request, so we walk back in batches.
async function fetchKlinesHistory(symbol, interval = '5m', total = 3000, maxPerReq = 500) {
  let all = [];
  let endTime = null;
  let guard = 0;
  while (all.length < total && guard < 40) {
    guard++;
    let url = `${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${maxPerReq}`;
    if (endTime != null) url += `&endTime=${endTime}`;
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) break;
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;
    const batch = raw.map((r) => ({
      openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
      low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
      closeTime: Number(r[6]), quoteVolume: Number(r[7]),
    }));
    all = batch.concat(all); // prepend older data
    const oldest = batch[0].openTime;
    if (endTime != null && oldest >= endTime) break; // no progress
    endTime = oldest - 1;
    if (batch.length < maxPerReq) break; // exhausted history
  }
  // Deduplicate by openTime and sort ascending.
  const seen = new Map();
  for (const c of all) seen.set(c.openTime, c);
  return [...seen.values()].sort((a, b) => a.openTime - b.openTime);
}

// Fetch several timeframes independently. One temporary endpoint failure should
// degrade only the affected horizon, not blank the whole dashboard.
async function fetchMultiTimeframe(symbol, timeframes = ['5m', '15m', '30m'], limit = 200) {
  const startedAt = Date.now();
  const results = {};
  const errors = {};
  await Promise.all(
    timeframes.map(async (tf) => {
      try {
        results[tf] = await fetchKlines(symbol, tf, limit);
      } catch (error) {
        errors[tf] = error.message;
      }
    })
  );
  results.errors = errors;
  results.meta = { startedAt, fetchedAt: Date.now(), durationMs: Date.now() - startedAt };
  if (!timeframes.some((tf) => Array.isArray(results[tf]) && results[tf].length)) {
    throw new Error(`All MEXC timeframe requests failed for ${symbol}`);
  }
  return results;
}

// Get the first aggregate trade at or after the intended paper settlement.
// Never substitute a later ticker: that could reverse the recorded outcome.
// The journal retries temporary gaps and eventually marks the entry VOID.
async function fetchSettlementPrice(symbol, targetMs) {
  const startTime = Math.floor(Number(targetMs));
  const graceEnd = startTime + 5 * 60 * 1000;
  // Retries progressively widen the historical window as the grace period
  // elapses, while preserving the first trade at/after the exact target.
  const endTime = Math.max(startTime + 1, Math.min(Date.now(), graceEnd));
  const url = `${BASE}/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&startTime=${startTime}&endTime=${endTime}&limit=100`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MEXC settlement ${symbol} -> HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  const trades = await res.json();
  if (Array.isArray(trades) && trades.length) {
    const candidates = trades
      .map((trade) => ({ price: Number(trade.p), time: Number(trade.T ?? trade.time) }))
      .filter((trade) => Number.isFinite(trade.price) && Number.isFinite(trade.time) && trade.time >= startTime)
      .sort((a, b) => a.time - b.time);
    if (candidates.length) return candidates[0].price;
  }
  throw new Error(`No aggregate trade available for ${symbol} at settlement ${startTime}`);
}

async function fetchPrice(symbol) {
  const res = await fetchWithTimeout(`${BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`MEXC price ${symbol} -> HTTP ${res.status}`);
  const j = await res.json();
  return Number(j.price);
}

async function ping() {
  const res = await fetchWithTimeout(`${BASE}/api/v3/ping`, {}, 5000);
  return res.ok;
}

// Helper extractors used by the indicator/SMC layers.
const closes = (candles) => candles.map((c) => c.close);
const highs = (candles) => candles.map((c) => c.high);
const lows = (candles) => candles.map((c) => c.low);
const volumes = (candles) => candles.map((c) => c.volume);

module.exports = {
  BASE,
  VALID_INTERVALS,
  aggregateCandles,
  fetchKlines,
  fetchKlinesHistory,
  fetchMultiTimeframe,
  fetchSettlementPrice,
  fetchPrice,
  ping,
  closes,
  highs,
  lows,
  volumes,
};
