'use strict';

const BASE = 'https://api.mexc.com';

function weightedNotional(rows, mid, decayBps = 8) {
  if (!Array.isArray(rows) || !Number.isFinite(mid) || mid <= 0) return 0;
  return rows.reduce((sum, row) => {
    const price = Number(row[0]);
    const qty = Number(row[1]);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) return sum;
    const distanceBps = Math.abs(price / mid - 1) * 10000;
    return sum + price * qty * Math.exp(-distanceBps / decayBps);
  }, 0);
}

async function getOrderFlow(symbol, depthLimit = 50, tradesLimit = 1000) {
  const [depthRes, tradesRes] = await Promise.all([
    fetch(`${BASE}/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${depthLimit}`),
    fetch(`${BASE}/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=${tradesLimit}`),
  ]);
  if (!depthRes.ok || !tradesRes.ok) {
    throw new Error(`orderflow ${symbol} -> depth ${depthRes.status}, trades ${tradesRes.status}`);
  }
  const depth = await depthRes.json();
  const trades = await tradesRes.json();
  const bestBid = Number(depth.bids?.[0]?.[0]);
  const bestAsk = Number(depth.asks?.[0]?.[0]);
  const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = mid ? ((bestAsk - bestBid) / mid) * 10000 : null;

  // Near-touch USD notional receives exponentially more weight than distant,
  // easily spoofed walls. Microprice captures pressure at the best level.
  const bidVol = weightedNotional(depth.bids, mid);
  const askVol = weightedNotional(depth.asks, mid);
  const imbalance = bidVol + askVol > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0;
  const bestBidQty = Number(depth.bids?.[0]?.[1]) || 0;
  const bestAskQty = Number(depth.asks?.[0]?.[1]) || 0;
  const microprice = bestBidQty + bestAskQty > 0
    ? (bestAsk * bestBidQty + bestBid * bestAskQty) / (bestBidQty + bestAskQty)
    : mid;
  const microBias = mid && microprice ? Math.max(-1, Math.min(1, ((microprice - mid) / mid) * 10000 / 2)) : 0;

  const parsedTrades = (Array.isArray(trades) ? trades : []).map((t) => ({
    qty: Number(t.q),
    price: Number(t.p),
    ts: Number(t.T ?? t.time),
    buyerIsMaker: t.m === true || t.m === 'true',
  })).filter((t) => Number.isFinite(t.qty) && Number.isFinite(t.price) && Number.isFinite(t.ts));
  const lastTradeTs = parsedTrades.length ? Math.max(...parsedTrades.map((t) => t.ts)) : null;
  let buyVol = 0;
  let sellVol = 0;
  for (const t of parsedTrades) {
    const ageSec = (lastTradeTs - t.ts) / 1000;
    if (ageSec < 0 || ageSec > 60) continue;
    const notional = t.qty * t.price * Math.exp(-ageSec / 20);
    if (t.buyerIsMaker) sellVol += notional;
    else buyVol += notional;
  }
  const delta = buyVol + sellVol > 0 ? (buyVol - sellVol) / (buyVol + sellVol) : 0;

  const pressure = 0.35 * imbalance + 0.5 * delta + 0.15 * microBias;
  const lastTradeAgeSec = lastTradeTs == null ? null : Math.max(0, (Date.now() - lastTradeTs) / 1000);
  const tradeWindowSec = parsedTrades.length > 1
    ? Math.min(60, (lastTradeTs - Math.min(...parsedTrades.map((t) => t.ts))) / 1000)
    : 0;
  const insufficient = lastTradeAgeSec == null || lastTradeAgeSec > 15 || tradeWindowSec < 30 || buyVol + sellVol < 1000;
  let state = insufficient ? 'insufficient' : 'neutru';
  if (!insufficient && pressure > 0.15) state = 'buy';
  else if (!insufficient && pressure < -0.15) state = 'sell';

  return {
    imbalance: +imbalance.toFixed(3),
    delta: +delta.toFixed(3),
    microBias: +microBias.toFixed(3),
    pressure: +pressure.toFixed(3),
    state,
    mid: mid != null ? +mid.toFixed(4) : null,
    microprice: microprice != null ? +microprice.toFixed(4) : null,
    spreadBps: spreadBps != null ? +spreadBps.toFixed(2) : null,
    bidNotional: +bidVol.toFixed(2),
    askNotional: +askVol.toFixed(2),
    buyNotional: +buyVol.toFixed(2),
    sellNotional: +sellVol.toFixed(2),
    tradeWindowSec: +tradeWindowSec.toFixed(1),
    lastTradeAgeSec: lastTradeAgeSec != null ? +lastTradeAgeSec.toFixed(1) : null,
    observedAt: Date.now(),
  };
}

function agreement(direction, of) {
  if (!of || !['buy', 'sell'].includes(of.state) || direction === 'NEUTRU') return 'neutru';
  const bullish = of.state === 'buy';
  if (direction === 'UP') return bullish ? 'confirmă' : 'conflict';
  if (direction === 'DOWN') return bullish ? 'conflict' : 'confirmă';
  return 'neutru';
}

module.exports = { getOrderFlow, agreement, weightedNotional, BASE };
