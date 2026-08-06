'use strict';

const BASE_URL = 'https://api.mexc.com';
const TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '30m', '60m']);
const INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '60m': 3_600_000,
});
const SOURCE = 'MEXC spot REST api.mexc.com';
const FRESHNESS_TOLERANCE_MS = 5_000;
const ANALYSIS_CANDLE_COUNT = 300;
// MEXC can return the current forming candle and, during settleDelay, the candle
// that just reached its end boundary. Two spare rows still leave 300 settled rows.
const REQUEST_CANDLE_COUNT = ANALYSIS_CANDLE_COUNT + 2;

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchJson(url, { timeoutMs = 8_000, fetchImpl = fetch } = {}) {
  const timeout = timeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'SignalPilot-Expert/1.0' },
      signal: timeout.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 180) || response.statusText}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`invalid JSON: ${body.slice(0, 180)}`);
    }
  } catch (error) {
    if (error && (error.name === 'AbortError' || /timeout/i.test(error.message))) {
      throw new Error(`request timeout (${timeoutMs}ms) for ${url}`);
    }
    throw error;
  } finally {
    timeout.clear();
  }
}

async function getScanClock(options = {}) {
  const localBefore = Date.now();
  try {
    const payload = await fetchJson(`${BASE_URL}/api/v3/time`, options);
    const localAfter = Date.now();
    const serverTime = Number(payload && payload.serverTime);
    if (!Number.isFinite(serverTime) || serverTime <= 0) throw new Error('serverTime missing or invalid');
    const midpoint = localBefore + (localAfter - localBefore) / 2;
    const localSkewMs = Math.round(serverTime - midpoint);
    return {
      asOf: Math.floor(localAfter + localSkewMs),
      measuredAt: localAfter,
      roundTripMs: localAfter - localBefore,
      source: 'MEXC /api/v3/time (midpoint skew corrected)',
      fallback: false,
      localSkewMs,
    };
  } catch (error) {
    const now = Date.now();
    return {
      asOf: now,
      measuredAt: now,
      roundTripMs: now - localBefore,
      source: 'local clock fallback (MEXC server-time unavailable)',
      fallback: true,
      warning: error.message,
      localSkewMs: 0,
    };
  }
}

function correctedNow(clock, localNow = Date.now()) {
  return Math.floor(localNow + (Number.isFinite(clock && clock.localSkewMs) ? clock.localSkewMs : 0));
}

function normalizeCandle(row, symbol, timeframe) {
  if (!Array.isArray(row) || row.length < 7) throw new Error(`${symbol} ${timeframe}: malformed kline row`);
  const intervalMs = INTERVAL_MS[timeframe];
  if (!intervalMs) throw new Error(`${symbol} ${timeframe}: unsupported timeframe`);
  const openTime = Number(row[0]);
  const rawEndTime = Number(row[6]);
  const expectedEndTime = openTime + intervalMs;
  // MEXC normally returns an exclusive interval-end boundary in row[6]. Accept
  // the inclusive variant explicitly too, then keep one internal convention.
  const boundaryFormat = rawEndTime === expectedEndTime
    ? 'exclusive-end' : rawEndTime === expectedEndTime - 1 ? 'inclusive-close' : null;
  const candle = {
    openTime, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]),
    endTime: expectedEndTime, closeTime: expectedEndTime - 1,
    sourceEndTime: rawEndTime, boundaryFormat,
    quoteVolume: row[7] == null ? null : Number(row[7]),
  };
  const finite = ['openTime', 'open', 'high', 'low', 'close', 'volume', 'endTime', 'closeTime', 'sourceEndTime']
    .every((key) => Number.isFinite(candle[key]));
  const quoteVolumeValid = candle.quoteVolume == null || (Number.isFinite(candle.quoteVolume) && candle.quoteVolume >= 0);
  const validRange = candle.openTime >= 0 && candle.endTime > candle.openTime
    && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 && candle.volume >= 0
    && candle.high >= Math.max(candle.open, candle.close, candle.low)
    && candle.low <= Math.min(candle.open, candle.close, candle.high);
  const validTiming = candle.openTime % intervalMs === 0 && boundaryFormat !== null;
  if (!finite || !quoteVolumeValid || !validRange || !validTiming) {
    throw new Error(`${symbol} ${timeframe}: invalid OHLCV/timing at openTime=${row[0]} rawEndTime=${row[6]} expectedEnd=${expectedEndTime}`);
  }
  return candle;
}

function normalizeClosedRows(raw, {
  symbol, timeframe, asOf, settleDelayMs,
  minimumCandles = ANALYSIS_CANDLE_COUNT,
  maximumCandles = ANALYSIS_CANDLE_COUNT,
}) {
  if (!Array.isArray(raw)) throw new Error(`${symbol} ${timeframe}: response is not an array`);
  const cutoff = asOf - settleDelayMs;
  const byOpenTime = new Map();
  for (const row of raw) {
    const candle = normalizeCandle(row, symbol, timeframe);
    if (candle.endTime <= cutoff) byOpenTime.set(candle.openTime, candle);
  }
  const candles = [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
  if (candles.length < minimumCandles) throw new Error(`${symbol} ${timeframe}: only ${candles.length} closed candles; need ${minimumCandles}`);
  return candles.slice(-maximumCandles);
}

function buildMetadata(candles, { timeframe, asOf, settleDelayMs }) {
  const intervalMs = INTERVAL_MS[timeframe];
  if (!intervalMs || !candles.length) throw new Error(`${timeframe}: metadata requires candles`);
  const last = candles[candles.length - 1];
  const gaps = [];
  const recentStart = Math.max(1, candles.length - 100);
  for (let i = 1; i < candles.length; i += 1) {
    const delta = candles[i].openTime - candles[i - 1].openTime;
    if (delta !== intervalMs) {
      gaps.push({
        afterOpenTime: candles[i - 1].openTime,
        beforeOpenTime: candles[i].openTime,
        missing: delta > intervalMs ? Math.max(1, Math.round(delta / intervalMs) - 1) : 1,
        recent: i >= recentStart,
        reason: delta > intervalMs ? 'missing' : 'overlap/non-grid',
      });
    }
  }
  const hasExclusiveEnd = Number.isFinite(last.endTime);
  const lastEndTime = hasExclusiveEnd ? last.endTime : last.closeTime + 1;
  const settlementTime = hasExclusiveEnd ? last.endTime : last.closeTime;
  const ageMs = Math.max(0, asOf - settlementTime);
  const freshnessLimitMs = intervalMs + settleDelayMs + FRESHNESS_TOLERANCE_MS;
  const gapsTotal = gaps.reduce((sum, gap) => sum + gap.missing, 0);
  const gapsRecent = gaps.filter((gap) => gap.recent).reduce((sum, gap) => sum + gap.missing, 0);
  const closed = settlementTime <= asOf - settleDelayMs;
  const fresh = ageMs <= freshnessLimitMs;
  return {
    timeframe, intervalMs, count: candles.length,
    lastOpenTime: last.openTime, lastCloseTime: last.closeTime, lastEndTime,
    ageMs, freshnessLimitMs, closed,
    gaps: gapsTotal, gapsRecent, analysisWindowContinuous: gapsTotal === 0,
    gapDetails: gaps.slice(-10), fresh, valid: closed && fresh && gapsTotal === 0, source: SOURCE,
  };
}

function revalidateSnapshot(snapshot, generatedAt) {
  const metadata = {};
  for (const timeframe of TIMEFRAMES) {
    metadata[timeframe] = buildMetadata(snapshot.candles[timeframe] || [], {
      timeframe,
      asOf: generatedAt,
      settleDelayMs: snapshot.settleDelayMs || 0,
    });
  }
  return { ...snapshot, asOf: generatedAt, generatedAt, metadata };
}

async function fetchTimeframe(symbol, timeframe, { asOf, settleDelayMs, limit = REQUEST_CANDLE_COUNT, timeoutMs = 8_000, fetchImpl } = {}) {
  if (!TIMEFRAMES.includes(timeframe)) throw new Error(`unsupported MEXC timeframe: ${timeframe}`);
  const url = `${BASE_URL}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&limit=${limit}`;
  let raw;
  try {
    raw = await fetchJson(url, { timeoutMs, fetchImpl });
  } catch (error) {
    throw new Error(`MEXC ${symbol} ${timeframe} failed: ${error.message}`);
  }
  const candles = normalizeClosedRows(raw, { symbol, timeframe, asOf, settleDelayMs });
  return { candles, metadata: buildMetadata(candles, { timeframe, asOf, settleDelayMs }) };
}

async function fetchSymbolSnapshot(symbol, { asOf, settleDelayMs = 1_500, limit = REQUEST_CANDLE_COUNT, timeoutMs = 8_000, fetchImpl } = {}) {
  if (!Number.isFinite(asOf)) throw new Error('fetchSymbolSnapshot requires a finite scan asOf');
  const results = await Promise.all(TIMEFRAMES.map(async (timeframe) => [
    timeframe,
    await fetchTimeframe(symbol, timeframe, { asOf, settleDelayMs, limit, timeoutMs, fetchImpl }),
  ]));
  const candles = {};
  const metadata = {};
  for (const [timeframe, result] of results) {
    candles[timeframe] = result.candles;
    metadata[timeframe] = result.metadata;
  }
  return { symbol, asOf, generatedAt: asOf, settleDelayMs, source: SOURCE, candles, metadata };
}

async function fetchLiveTicker(symbol, { timeoutMs = 1_500, fetchImpl } = {}) {
  const startedAt = Date.now();
  const url = `${BASE_URL}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
  let payload;
  try {
    payload = await fetchJson(url, { timeoutMs, fetchImpl });
  } catch (error) {
    throw new Error(`MEXC ${symbol} live ticker failed: ${error.message}`);
  }
  const lastPrice = Number(payload && (payload.lastPrice ?? payload.price));
  const bidPrice = Number(payload && payload.bidPrice);
  const askPrice = Number(payload && payload.askPrice);
  const priceChangePercent = Number(payload && payload.priceChangePercent);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) throw new Error(`MEXC ${symbol} live ticker returned invalid lastPrice`);
  const bid = Number.isFinite(bidPrice) && bidPrice > 0 ? bidPrice : null;
  const ask = Number.isFinite(askPrice) && askPrice > 0 ? askPrice : null;
  const spreadBps = bid && ask && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : null;
  const receivedAt = Date.now();
  return {
    symbol, lastPrice, bidPrice: bid, askPrice: ask,
    spreadBps: Number.isFinite(spreadBps) ? Number(spreadBps.toFixed(3)) : null,
    priceChangePercent: Number.isFinite(priceChangePercent) ? priceChangePercent : null,
    receivedAt, latencyMs: receivedAt - startedAt,
    source: 'MEXC spot REST /api/v3/ticker/24hr · refresh 1s',
  };
}

async function fetchLiveTickers(symbols, options = {}) {
  const results = await Promise.allSettled((symbols || []).map((symbol) => fetchLiveTicker(symbol, options)));
  const tickers = {};
  const errors = {};
  results.forEach((result, index) => {
    const symbol = symbols[index];
    if (result.status === 'fulfilled') tickers[symbol] = result.value;
    else errors[symbol] = { at: Date.now(), message: result.reason.message };
  });
  return { tickers, errors, fetchedAt: Date.now() };
}

module.exports = {
  BASE_URL, SOURCE, TIMEFRAMES, INTERVAL_MS, FRESHNESS_TOLERANCE_MS,
  ANALYSIS_CANDLE_COUNT, REQUEST_CANDLE_COUNT,
  fetchJson, getScanClock, correctedNow, normalizeCandle, normalizeClosedRows,
  buildMetadata, revalidateSnapshot, fetchTimeframe, fetchSymbolSnapshot,
  fetchLiveTicker, fetchLiveTickers,
};
