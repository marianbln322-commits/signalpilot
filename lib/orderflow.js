'use strict';

// ============================================================================
// orderflow.js — LIVE order-flow read (what a scalper actually watches).
// Uses MEXC public endpoints:
//   - /api/v3/depth     -> order book imbalance (resting buy vs sell walls)
//   - /api/v3/aggTrades -> aggression delta (taker buys vs taker sells)
// This data is NOT available historically, so it can't be backtested — it is a
// LIVE confirmation layer, validated forward through the journal.
//
// aggTrades field `m` = "buyer is maker": m=true  -> aggressive SELL,
//                                         m=false -> aggressive BUY.
// ============================================================================

const BASE = 'https://api.mexc.com';

async function getOrderFlow(symbol, depthLimit = 50, tradesLimit = 200) {
  const [depthRes, tradesRes] = await Promise.all([
    fetch(`${BASE}/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${depthLimit}`),
    fetch(`${BASE}/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=${tradesLimit}`),
  ]);
  if (!depthRes.ok || !tradesRes.ok) {
    throw new Error(`orderflow ${symbol} -> depth ${depthRes.status}, trades ${tradesRes.status}`);
  }
  const depth = await depthRes.json();
  const trades = await tradesRes.json();

  // Order book imbalance over the fetched levels.
  const sumQty = (rows) => (Array.isArray(rows) ? rows.reduce((s, r) => s + Number(r[1]), 0) : 0);
  const bidVol = sumQty(depth.bids);
  const askVol = sumQty(depth.asks);
  const imbalance = bidVol + askVol > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0;

  // Aggression delta from recent taker trades.
  let buyVol = 0;
  let sellVol = 0;
  if (Array.isArray(trades)) {
    for (const t of trades) {
      const q = Number(t.q);
      if (t.m === false) buyVol += q; // buyer is taker -> aggressive BUY
      else sellVol += q;              // buyer is maker -> aggressive SELL
    }
  }
  const delta = buyVol + sellVol > 0 ? (buyVol - sellVol) / (buyVol + sellVol) : 0;

  // Combined pressure and a discrete state.
  const pressure = (imbalance + delta) / 2; // -1..1
  let state = 'neutru';
  if (pressure > 0.15) state = 'buy';
  else if (pressure < -0.15) state = 'sell';

  return {
    imbalance: +imbalance.toFixed(3),
    delta: +delta.toFixed(3),
    pressure: +pressure.toFixed(3),
    state,
    bidVol: +bidVol.toFixed(2),
    askVol: +askVol.toFixed(2),
    buyVol: +buyVol.toFixed(2),
    sellVol: +sellVol.toFixed(2),
  };
}

// How does order flow relate to a signal's direction?
function agreement(direction, of) {
  if (!of || of.state === 'neutru' || direction === 'NEUTRU') return 'neutru';
  const bullish = of.state === 'buy';
  if (direction === 'UP') return bullish ? 'confirmă' : 'conflict';
  if (direction === 'DOWN') return bullish ? 'conflict' : 'confirmă';
  return 'neutru';
}

module.exports = { getOrderFlow, agreement, BASE };
