#!/usr/bin/env node
'use strict';

// ============================================================================
// collect.js — downloads deep candle history to a local file.
//
// WHY THIS RUNS ON YOUR MACHINE AND NOT MINE
// The environment I build in has no outbound network. I verified it rather than
// assuming: `curl` to contract.mexc.com fails at the socket, and my web-fetch
// channel returns HTTP 403 for every market API tried (Binance data mirror, MEXC
// spot, Kraken, OKX, CoinGecko). So I cannot fetch training data — you have to,
// once, with this script. It takes well under a minute.
//
// "A million trades of experience" is a dataset size, not a metaphor. One year of
// 5-minute bars is ~105,000 bars per symbol; each becomes a labelled example at
// each horizon. Two symbols, two horizons, and you are past 400,000 labelled
// outcomes — the same order of magnitude as a career of manual trading, except
// every one of them is measured rather than remembered.
//
// SOURCE
// Binance's public data mirror honours startTime and serves deep history without
// a key; MEXC's public klines endpoint ignores it and only returns the most
// recent ~500 bars, so it cannot support training. BTC/ETH prices track within a
// few basis points across venues, which is acceptable for FITTING. Grading and
// live signals still use MEXC — see the note on index price in the README.
//
// USAGE
//   node tools/collect.js --symbol ETHUSDT --days 365
//   node tools/collect.js --symbol BTCUSDT --days 365 --interval 5m
//   node tools/collect.js --symbol ETHUSDT --days 730 --out data/eth-2y.json
// ============================================================================

const fs = require('fs');
const path = require('path');

const BASE = 'https://data-api.binance.vision';
const MAX_PER_REQ = 1000;

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const INTERVAL_MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3,
  '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collect(symbol, interval, days, onProgress) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`interval nesuportat: ${interval}`);
  const end = Date.now();
  let start = end - days * 86400e3;
  const expected = Math.ceil((end - start) / step);

  const seen = new Map();
  let guard = 0;
  const maxGuard = Math.ceil(expected / MAX_PER_REQ) + 20;

  while (start < end && guard < maxGuard) {
    guard++;
    const url = `${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${interval}&limit=${MAX_PER_REQ}&startTime=${start}`;
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      console.error(`\n  rețea: ${e.message} — reîncerc în 2s`);
      await sleep(2000);
      continue;
    }
    if (res.status === 429 || res.status === 418) {
      const wait = Number(res.headers.get('retry-after') || 5) * 1000;
      console.error(`\n  rate limit — aștept ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      console.error(`\n  HTTP ${res.status} — mă opresc aici`);
      break;
    }
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const r of raw) {
      const openTime = Number(r[0]);
      seen.set(openTime, {
        openTime,
        open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
        volume: Number(r[5]), closeTime: Number(r[6]), quoteVolume: Number(r[7]),
      });
    }
    const lastOpen = Number(raw[raw.length - 1][0]);
    if (lastOpen <= start) break; // no forward progress
    start = lastOpen + 1;
    onProgress(seen.size, expected);
    if (raw.length < MAX_PER_REQ) break;
    await sleep(120); // stay well inside the published limits
  }

  const rows = [...seen.values()].sort((a, b) => a.openTime - b.openTime);
  // The final bar may still be forming; training must never see it.
  if (rows.length && rows[rows.length - 1].closeTime > Date.now()) rows.pop();
  return rows;
}

function gaps(rows, interval) {
  const step = INTERVAL_MS[interval];
  let missing = 0;
  let worst = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i].openTime - rows[i - 1].openTime;
    if (d > step) {
      missing += Math.round(d / step) - 1;
      worst = Math.max(worst, d);
    }
  }
  return { missing, worstGapMin: Math.round(worst / 60000) };
}

(async () => {
  const symbol = String(arg('symbol', 'ETHUSDT')).toUpperCase();
  const interval = String(arg('interval', '5m'));
  const days = Number(arg('days', 365));
  const outArg = arg('out', null);
  const outDir = path.join(__dirname, '..', 'data');
  const out = outArg ? path.resolve(String(outArg))
    : path.join(outDir, `${symbol}-${interval}-${days}d.json`);

  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log('='.repeat(70));
  console.log(`  COLLECT — ${symbol} ${interval}, ${days} zile`);
  console.log('='.repeat(70));
  console.log(`  sursă : ${BASE}`);
  console.log(`  ieșire: ${out}\n`);

  const t0 = Date.now();
  let lastPrint = 0;
  const rows = await collect(symbol, interval, days, (got, expected) => {
    const now = Date.now();
    if (now - lastPrint < 250) return;
    lastPrint = now;
    const pct = Math.min(100, (got / expected) * 100);
    process.stdout.write(`\r  ${got} bare  (${pct.toFixed(1)}%)   `);
  });
  process.stdout.write('\n');

  if (!rows.length) {
    console.error('\n  Nu am primit nicio bară. Verifică simbolul și conexiunea.');
    process.exit(1);
  }

  const g = gaps(rows, interval);
  const first = new Date(rows[0].openTime).toISOString();
  const last = new Date(rows[rows.length - 1].openTime).toISOString();

  fs.writeFileSync(out, JSON.stringify(rows));
  const sizeMb = (fs.statSync(out).size / 1e6).toFixed(1);

  console.log(`\n  gata în ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  bare      : ${rows.length}`);
  console.log(`  perioadă  : ${first}  ->  ${last}`);
  console.log(`  lipsuri   : ${g.missing} bare` + (g.missing ? `  (cel mai mare gol: ${g.worstGapMin} min)` : ''));
  console.log(`  fișier    : ${sizeMb} MB`);
  console.log(`\n  Urmează:\n    node tools/train.js --file ${path.relative(path.join(__dirname, '..'), out)} --horizon 10`);
  console.log('='.repeat(70));
})();
