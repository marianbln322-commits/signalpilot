# SignalPilot — pachet complet de cod pentru analiză

Aplicație locală Node.js care citește date live de pe MEXC, calculează indicatori tehnici + Smart Money Concepts + order flow, produce decizii UP/DOWN pe 10/30 min pentru event-futures, cu Sniper Mode, jurnal auto-rezolvat și strat de învățare din rezultate.

**Pentru AI-ul care analizează:** evaluează logica de predicție (lib/engine.js, lib/smc.js, lib/orderflow.js, lib/learning.js), spune ce ar îmbunătăți acuratețea semnalelor pe 10/30 min și ce mai lipsește. Notează: order flow-ul nu se poate backtesta (date live), restul e determinist.

Structura:
```
./config.example.json
./lib/backtest.js
./lib/binance.js
./lib/engine.js
./lib/gemini.js
./lib/indicators.js
./lib/journal.js
./lib/learning.js
./lib/mexc.js
./lib/orderflow.js
./lib/smc.js
./package.json
./public/app.js
./public/index.html
./public/style.css
./README.md
./server.js
```


## `package.json`

```json
{
  "name": "signalpilot",
  "version": "1.0.0",
  "description": "Local real-time MEXC signal engine for 10/30-min event-futures UP/DOWN decisions (deterministic indicators + SMC, optional Gemini narrator, backtest).",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "author": "",
  "license": "MIT",
  "dependencies": {
    "express": "^4.19.2"
  }
}
```

## `server.js`

```javascript
'use strict';

// ============================================================================
// SignalPilot server — always-on local app (PinPilot style).
// Serves the UI at http://localhost:3005, polls MEXC, runs the engine on a
// scheduler, pushes live updates over SSE, and alerts on good setups.
// ============================================================================

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore if it fails; user can open manually */ });
}

const mexc = require('./lib/mexc');
const engine = require('./lib/engine');
const gemini = require('./lib/gemini');
const backtest = require('./lib/backtest');
const journal = require('./lib/journal');
const orderflow = require('./lib/orderflow');
const learning = require('./lib/learning');

// Port 3005 by default so it runs alongside PinPilot (3004) and older
// SignalPilot versions (3001/3002). Override with the PORT env var if needed.
const PORT = process.env.PORT || 3005;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  scanIntervalSec: 8,
  alertMinConfidence: 'Mediu',
  // Sniper mode: only act on the out-of-sample-validated A+ setup
  // (liquidity sweep + volume + active session hours). Alerts fire only on these.
  sniperMode: true,
  // Volume confirmation OFF by default: "sweep + active hours" fires ~10/day
  // (trader-like cadence) and backtested similarly; the volume filter did not
  // robustly help out-of-sample. Turn ON for a stricter ~4-5/day.
  sniperRequireVolume: false,
  activeHoursUTC: [6, 7, 8, 9, 13, 14, 15, 16, 17],
  // Interval is decided by the setup type (fast -> 10 min, structural -> 30 min).
  // adaptiveInterval (optional, OFF by default) only nudges 10 -> 30 when the
  // 10-min payout is too poor. Payout/EV is always shown as info either way.
  adaptiveInterval: false,
  payout10: 65,          // current MEXC payout % for 10-min contracts (user updates)
  payout30: 82,          // current MEXC payout % for 30-min contracts
  fallbackWinRate: 55,   // assumed win-rate when the journal has too few samples yet (sniper OOS ~55%)
  // Live order flow (order book + trade aggression). Confirms/vetoes direction.
  useOrderFlow: true,
  requireOfAgree: false, // if true, only alert when order flow does NOT conflict
  // Self-learning: calibrate from the user's own journal, session to session.
  useLearning: true,
  learningSuppressBelow: 45, // if learned estimate < this (%), suppress the alert
  gemini: { enabled: false, apiKey: '', model: 'gemini-3.5-flash' },
};

const CONF_RANK = { Scăzut: 1, Mediu: 2, Ridicat: 3 };

let config = loadConfig();
const latest = {};          // symbol -> last verdict
const alerts = [];          // recent alert feed
const sseClients = new Set();

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('Config read error, using defaults:', e.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Config write error:', e.message);
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* client gone */ }
  }
}

// ---- Core scan for one symbol ----------------------------------------------
async function scanSymbol(symbol) {
  const mtf = await mexc.fetchMultiTimeframe(symbol, ['5m', '15m', '60m'], 200);
  const verdict = engine.decide(mtf);
  verdict.symbol = symbol;

  // Interval = the setup's NATURAL window (fast momentum like sweeps -> 10 min,
  // structural setups -> 30 min). Payout/EV is shown as INFO, and only used to
  // adapt 10 -> 30 when adaptiveInterval is ON and the 10-min payout is poor.
  // This keeps BOTH 10-min and 30-min signals instead of forcing everything 30.
  if (verdict.directie !== 'NEUTRU') {
    const ji = journal.recentByInterval(20);
    const wr10 = (ji.tenMin.n >= 8 && ji.tenMin.winRate != null) ? ji.tenMin.winRate : config.fallbackWinRate;
    const wr30 = (ji.thirtyMin.n >= 8 && ji.thirtyMin.winRate != null) ? ji.thirtyMin.winRate : config.fallbackWinRate;
    const p10 = config.payout10 / 100;
    const p30 = config.payout30 / 100;
    const evOf = (wr, p) => (wr / 100) * p - (1 - wr / 100); // per $1 staked
    const ev10 = evOf(wr10, p10);
    const ev30 = evOf(wr30, p30);
    const breakEven = (p) => +(100 / (1 + p)).toFixed(1);

    const natural = verdict.interval; // set by engine from setup type
    let chosen = natural;
    // Optional trader-style adaptation: only nudge 10 -> 30 when 10-min EV is
    // negative but 30-min is meaningfully better. Off by default.
    if (config.adaptiveInterval && natural === '10 minute' && ev10 < 0 && ev30 > ev10) {
      chosen = '30 minute';
      verdict.intervalAdapted = { from: '10 minute', reason: `payout 10 min slab (EV ${(ev10 * 100).toFixed(1)}%) → 30 min` };
    }
    verdict.interval = chosen;

    const chosenEv = chosen === '30 minute' ? ev30 : ev10;
    verdict.ev = {
      payout10: config.payout10,
      payout30: config.payout30,
      breakEven10: breakEven(p10),
      breakEven30: breakEven(p30),
      wr10,
      wr30,
      ev10: +(ev10 * 100).toFixed(1),
      ev30: +(ev30 * 100).toFixed(1),
      chosen,
      positive: chosenEv > 0,
    };
  }

  // Optional Gemini narration (numbers only, never an image).
  if (config.gemini && config.gemini.enabled && config.gemini.apiKey && verdict.directie !== 'NEUTRU') {
    const ai = await gemini.narrate(symbol, verdict, config.gemini);
    if (ai.used) {
      verdict.ai = { justificare: ai.justificare, acord: ai.acord, risc: ai.risc, comentariu: ai.comentariu };
      if (ai.justificare) verdict.justificare = ai.justificare;
    } else if (ai.error) {
      verdict.aiError = ai.error;
    }
  }

  // Sniper eligibility (uses live UTC hour).
  const hourUTC = new Date().getUTCHours();
  verdict.sniper = engine.sniperEligibility(verdict, hourUTC, config.activeHoursUTC, config.sniperRequireVolume);

  // Primary setup category (for learning + display).
  verdict.setup = primarySetup(verdict);

  // Live order flow (what a scalper reads): confirms or vetoes direction.
  if (config.useOrderFlow) {
    try {
      const of = await orderflow.getOrderFlow(symbol);
      verdict.orderflow = of;
      verdict.ofAgree = orderflow.agreement(verdict.directie, of);
    } catch (e) {
      verdict.orderflowError = e.message;
    }
  }

  // Self-learning: what does the user's own history say about this context?
  if (config.useLearning) {
    verdict.learned = learning.evaluate(journal.all(), {
      symbol,
      directie: verdict.directie,
      setup: verdict.setup,
      hourUTC,
      ofAgree: verdict.ofAgree,
    });
  }

  // Continuous learning: log one observation per 5m candle per symbol (even when
  // no alert fires) so the software keeps learning about ETH/BTC 24/7. These are
  // resolved automatically and feed the learning layer, but stay out of the
  // trade journal display.
  if (config.useLearning && verdict.directie !== 'NEUTRU') {
    try {
      const c5 = mtf['5m'];
      const candleOpen = c5[c5.length - 1].openTime;
      journal.record({
        observation: true,
        candleOpen,
        symbol,
        directie: verdict.directie,
        interval: verdict.interval,
        incredere: verdict.incredere,
        sniper: false,
        setup: verdict.setup,
        hourUTC,
        ofState: verdict.orderflow ? verdict.orderflow.state : null,
        ofAgree: verdict.ofAgree,
        price: verdict.price,
        ts: verdict.ts,
      });
    } catch { /* non-fatal */ }
  }

  const prev = latest[symbol];
  latest[symbol] = verdict;
  broadcast('signal', verdict);

  // Alert logic depends on mode.
  let shouldAlert;
  if (config.sniperMode) {
    // Only the A+ setup fires an alert.
    const wasEligible = prev && prev.sniper && prev.sniper.eligible;
    shouldAlert = verdict.sniper.eligible && (!wasEligible || prev.directie !== verdict.directie);
  } else {
    const meetsConf = verdict.directie !== 'NEUTRU' &&
      CONF_RANK[verdict.incredere] >= CONF_RANK[config.alertMinConfidence];
    const changed = !prev || prev.directie !== verdict.directie || prev.incredere !== verdict.incredere;
    shouldAlert = meetsConf && changed;
  }

  // Order-flow veto: optionally require live order flow to not contradict.
  if (shouldAlert && config.useOrderFlow && config.requireOfAgree && verdict.ofAgree === 'conflict') {
    shouldAlert = false;
    verdict.suppressed = 'order flow în conflict cu direcția';
  }
  // Learning veto: suppress conditions the user's own history shows as losing.
  if (shouldAlert && config.useLearning && verdict.learned && verdict.learned.ready &&
      verdict.learned.estimate != null && verdict.learned.estimate < config.learningSuppressBelow) {
    shouldAlert = false;
    verdict.suppressed = `istoricul tău dă doar ${verdict.learned.estimate}% pe acest tipar`;
  }

  if (shouldAlert) {
    const alert = {
      symbol,
      directie: verdict.directie,
      interval: verdict.interval,
      incredere: verdict.incredere,
      price: verdict.price,
      justificare: verdict.justificare,
      sniper: !!(verdict.sniper && verdict.sniper.eligible),
      ofState: verdict.orderflow ? verdict.orderflow.state : null,
      ofAgree: verdict.ofAgree || null,
      ts: verdict.ts,
    };
    alerts.unshift(alert);
    if (alerts.length > 50) alerts.pop();
    // Auto-journal every alert with rich context for the learning layer.
    const logged = journal.record({
      ...alert,
      setup: verdict.setup,
      hourUTC,
    });
    broadcast('alert', alert);
    if (logged) broadcast('journal', { stats: journal.stats(), recent: journal.recent(40), learning: learning.summary(journal.all()) });
    console.log(`[ALERT${alert.sniper ? ' 🎯 SNIPER' : ''}] ${symbol}: ${verdict.directie} ${verdict.interval} (${verdict.incredere}) OF:${alert.ofAgree || '-'} @ ${verdict.price}`);
  }
  return verdict;
}

// Categorize the primary trigger of a verdict into a setup label.
function primarySetup(verdict) {
  const sig = (verdict.signals || []).find((s) => /sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band/i.test(s.label));
  if (!sig) return 'context';
  const l = sig.label.toLowerCase();
  if (l.includes('sweep')) return 'Liquidity Sweep';
  if (l.includes('squeeze')) return 'Squeeze breakout';
  if (l.includes('structure shift')) return 'Market Structure Shift';
  if (l.includes('ifvg')) return 'Inversion FVG';
  if (l.includes('fvg')) return 'FVG retest';
  if (l.includes('divergen')) return 'RSI divergence';
  if (l.includes('crossover')) return 'MACD crossover';
  if (l.includes('absorb') || l.includes('distribu')) return 'Volume absorption';
  if (l.includes('reversie') || l.includes('band')) return 'Bollinger bounce';
  return 'context';
}

// Background resolver: closes out pending journal entries automatically.
async function resolveJournal() {
  try {
    const resolved = await journal.resolvePending((sym) => mexc.fetchPrice(sym));
    if (resolved.length) {
      broadcast('journal', { stats: journal.stats(), recent: journal.recent(40), learning: learning.summary(journal.all()) });
      for (const r of resolved) {
        console.log(`[RESOLVED] ${r.symbol} ${r.directie} ${r.entryPrice}->${r.exitPrice} => ${r.win ? 'WIN' : 'LOSS'}`);
      }
    }
  } catch (e) {
    console.error('Journal resolve error:', e.message);
  }
}

async function scanAll() {
  for (const symbol of config.symbols) {
    try {
      await scanSymbol(symbol);
    } catch (e) {
      console.error(`Scan error ${symbol}:`, e.message);
      broadcast('error', { symbol, message: e.message });
    }
  }
}

// ---- Scheduler --------------------------------------------------------------
let timer = null;
function startScheduler() {
  if (timer) clearInterval(timer);
  const ms = Math.max(3, config.scanIntervalSec) * 1000;
  timer = setInterval(scanAll, ms);
  scanAll(); // immediate first pass
  console.log(`Scheduler started (scan every ${config.scanIntervalSec}s) for: ${config.symbols.join(', ')}`);
}

// Journal resolver runs independently of the scan cadence.
let resolveTimer = null;
function startResolver() {
  if (resolveTimer) clearInterval(resolveTimer);
  resolveTimer = setInterval(resolveJournal, 10000);
}

// ---- HTTP -------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  res.json({
    config: { ...config, gemini: { ...config.gemini, apiKey: config.gemini.apiKey ? '********' : '' } },
    latest,
    alerts,
    journal: { stats: journal.stats(), recent: journal.recent(40) },
    learning: learning.summary(journal.all()),
  });
});

app.get('/api/journal', (req, res) => {
  res.json({ stats: journal.stats(), recent: journal.recent(100) });
});

app.get('/api/learning', (req, res) => {
  res.json(learning.summary(journal.all()));
});

app.post('/api/journal/reset', (req, res) => {
  journal.reset();
  broadcast('journal', { stats: journal.stats(), recent: journal.recent(40), learning: learning.summary(journal.all()) });
  res.json({ ok: true });
});

app.get('/api/signal', async (req, res) => {
  const symbol = (req.query.symbol || config.symbols[0]).toUpperCase();
  try {
    const verdict = await scanSymbol(symbol);
    res.json(verdict);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body.symbols) && body.symbols.length) {
    config.symbols = body.symbols.map((s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, ''));
  }
  if (body.scanIntervalSec) config.scanIntervalSec = Math.max(3, Number(body.scanIntervalSec));
  if (body.alertMinConfidence && CONF_RANK[body.alertMinConfidence]) {
    config.alertMinConfidence = body.alertMinConfidence;
  }
  if (typeof body.sniperMode === 'boolean') config.sniperMode = body.sniperMode;
  if (typeof body.sniperRequireVolume === 'boolean') config.sniperRequireVolume = body.sniperRequireVolume;
  if (typeof body.adaptiveInterval === 'boolean') config.adaptiveInterval = body.adaptiveInterval;
  if (body.payout10 != null) {
    const v = Number(body.payout10);
    if (v > 0 && v <= 500) config.payout10 = v;
  }
  if (body.payout30 != null) {
    const v = Number(body.payout30);
    if (v > 0 && v <= 500) config.payout30 = v;
  }
  if (body.fallbackWinRate != null) {
    const v = Number(body.fallbackWinRate);
    if (v >= 40 && v <= 70) config.fallbackWinRate = v;
  }
  if (Array.isArray(body.activeHoursUTC)) {
    config.activeHoursUTC = body.activeHoursUTC
      .map((h) => Number(h))
      .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  }
  if (typeof body.useOrderFlow === 'boolean') config.useOrderFlow = body.useOrderFlow;
  if (typeof body.requireOfAgree === 'boolean') config.requireOfAgree = body.requireOfAgree;
  if (typeof body.useLearning === 'boolean') config.useLearning = body.useLearning;
  if (body.learningSuppressBelow != null) {
    const v = Number(body.learningSuppressBelow);
    if (v >= 30 && v <= 55) config.learningSuppressBelow = v;
  }
  if (body.gemini) {
    config.gemini.enabled = !!body.gemini.enabled;
    if (typeof body.gemini.model === 'string' && body.gemini.model.trim()) config.gemini.model = body.gemini.model.trim();
    // Only replace the key if a real (non-masked) value is sent.
    if (typeof body.gemini.apiKey === 'string' && body.gemini.apiKey && !body.gemini.apiKey.includes('*')) {
      config.gemini.apiKey = body.gemini.apiKey.trim();
    }
  }
  saveConfig();
  startScheduler();
  res.json({ ok: true, config: { ...config, gemini: { ...config.gemini, apiKey: config.gemini.apiKey ? '********' : '' } } });
});

app.post('/api/test-ai', async (req, res) => {
  const key = req.body?.apiKey && !String(req.body.apiKey).includes('*')
    ? String(req.body.apiKey).trim()
    : config.gemini.apiKey;
  const model = req.body?.model || config.gemini.model;
  const result = await gemini.testKey({ apiKey: key, model });
  res.json(result);
});

app.get('/api/backtest', async (req, res) => {
  const symbol = (req.query.symbol || config.symbols[0]).toUpperCase();
  const days = Math.min(60, Math.max(3, Number(req.query.days) || 15));
  const endDaysAgo = Math.max(0, Number(req.query.endDaysAgo) || 0);
  try {
    const result = await backtest.run(symbol, { days, endDaysAgo });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE stream for live updates.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  // Send current state immediately.
  res.write(`event: snapshot\ndata: ${JSON.stringify({ latest, alerts, journal: { stats: journal.stats(), recent: journal.recent(40) }, learning: learning.summary(journal.all()) })}\n\n`);
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// ---- Boot -------------------------------------------------------------------
// Start on PORT, but if it's already in use (another window open), automatically
// try the next port instead of crashing. This makes double-clicking safe.
function startServer(port, attemptsLeft) {
  const server = app.listen(port, async () => {
    console.log('====================================================');
    console.log('  SignalPilot — MEXC live UP/DOWN engine');
    console.log('====================================================');
    console.log(`  Running at http://localhost:${port}`);
    console.log(`  AI (Gemini): ${config.gemini.enabled && config.gemini.apiKey ? 'ENABLED' : 'disabled'}`);
    console.log(`  Symbols: ${config.symbols.join(', ')}`);
    console.log('  (Se deschide singur in browser. Ca sa opresti: inchide fereastra.)');
    console.log('====================================================');
    const ok = await mexc.ping().catch(() => false);
    console.log(ok ? '  MEXC reachable: OK' : '  WARNING: MEXC not reachable from this machine.');
    startScheduler();
    startResolver();
    if (process.env.NO_OPEN !== '1') openBrowser(`http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  Portul ${port} e deja folosit (alta fereastra SignalPilot?). Incerc ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`\n  Toate porturile ${PORT}-${port} sunt ocupate.`);
      console.error('  Inchide celelalte ferestre SignalPilot si porneste din nou.\n');
      process.exit(1);
    } else {
      console.error('  Nu pot porni serverul:', err.message);
      process.exit(1);
    }
  });
}
startServer(PORT, 10);
```

## `lib/mexc.js`

```javascript
'use strict';

// ============================================================================
// mexc.js — MEXC spot public market-data feed.
// Uses the keyless REST klines endpoint (Binance-compatible). We poll instead
// of using the protobuf WebSocket: for 10/30-min decisions, a few seconds of
// freshness is more than enough and polling is far more robust.
//
// Kline row format: [openTime, open, high, low, close, volume, closeTime, quoteVolume]
// Symbols use no underscore at spot v3, e.g. BTCUSDT, ETHUSDT.
// Valid intervals: 1m, 5m, 15m, 30m, 60m  (NOTE: "1h" is rejected -> use "60m").
// ============================================================================

const BASE = 'https://api.mexc.com';

const VALID_INTERVALS = new Set(['1m', '5m', '15m', '30m', '60m', '4h', '1d']);

async function fetchKlines(symbol, interval = '15m', limit = 200) {
  if (!VALID_INTERVALS.has(interval)) {
    throw new Error(`Invalid interval "${interval}". Use one of: ${[...VALID_INTERVALS].join(', ')}`);
  }
  const url = `${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
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
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
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

// Fetch several timeframes at once for one symbol.
async function fetchMultiTimeframe(symbol, timeframes = ['5m', '15m', '30m'], limit = 200) {
  const results = {};
  await Promise.all(
    timeframes.map(async (tf) => {
      results[tf] = await fetchKlines(symbol, tf, limit);
    })
  );
  return results;
}

async function fetchPrice(symbol) {
  const res = await fetch(`${BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`MEXC price ${symbol} -> HTTP ${res.status}`);
  const j = await res.json();
  return Number(j.price);
}

async function ping() {
  const res = await fetch(`${BASE}/api/v3/ping`);
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
  fetchKlines,
  fetchKlinesHistory,
  fetchMultiTimeframe,
  fetchPrice,
  ping,
  closes,
  highs,
  lows,
  volumes,
};
```

## `lib/indicators.js`

```javascript
'use strict';

// ============================================================================
// indicators.js — deterministic technical indicators computed from OHLCV data.
// All functions take arrays of numbers and return either a full series or the
// latest value(s). No guessing, no image parsing — pure math on real candles.
// ============================================================================

function sma(values, period) {
  if (!values || values.length < period) return null;
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  if (!values || values.length < period) return null;
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// Wilder's RSI.
function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const out = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// MACD: returns { macd, signal, histogram } as aligned series.
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!closes || closes.length < slow + signalPeriod) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const macdValues = macdLine.filter((v) => v != null);
  const signalRaw = ema(macdValues, signalPeriod);
  // Re-align signal to the full length.
  const firstIdx = macdLine.findIndex((v) => v != null);
  const signalLine = new Array(closes.length).fill(null);
  if (signalRaw) {
    for (let i = 0; i < signalRaw.length; i++) {
      if (signalRaw[i] != null) signalLine[firstIdx + i] = signalRaw[i];
    }
  }
  const histogram = closes.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null
  );
  return { macd: macdLine, signal: signalLine, histogram };
}

// Bollinger Bands: returns { upper, mid, lower, bandwidth } series.
function bollinger(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const bandwidth = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    const m = mid[i];
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - m) ** 2;
    const sd = Math.sqrt(sumSq / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    bandwidth[i] = m !== 0 ? (upper[i] - lower[i]) / m : 0;
  }
  return { upper, mid, lower, bandwidth };
}

// Average True Range (Wilder).
function atr(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const tr = new Array(closes.length).fill(null);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < closes.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

// Rolling average of volume (excludes the current forming candle when asked).
function volumeAverage(volumes, period = 20) {
  return sma(volumes, period);
}

// Rolling VWAP (Volume-Weighted Average Price) over the last `period` bars.
// The intraday "fair value" anchor scalpers watch: price above a rising VWAP is
// a bullish bias, below a falling VWAP is bearish.
function vwap(candles, period = 96) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - period + 1);
    let pv = 0;
    let vol = 0;
    for (let j = start; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      pv += tp * candles[j].volume;
      vol += candles[j].volume;
    }
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

// Convenience: last non-null value of a series.
function last(series) {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}

module.exports = {
  sma,
  ema,
  rsi,
  macd,
  bollinger,
  atr,
  volumeAverage,
  vwap,
  last,
};
```

## `lib/smc.js`

```javascript
'use strict';

// ============================================================================
// smc.js — Smart Money Concepts detected deterministically from candles.
//   - swing points (fractals)
//   - market structure (HH/HL/LH/LL) + Market Structure Shift / CHoCH
//   - Fair Value Gaps (FVG) + Inversion FVG (IFVG)
//   - Liquidity Sweep / Swing Failure Pattern (SFP)
// Each detector returns plain objects the decision engine can score.
// ============================================================================

// ---- Swing points via a simple fractal (lookback/lookforward = span) --------
function swings(candles, span = 2) {
  const highsArr = [];
  const lowsArr = [];
  for (let i = span; i < candles.length - span; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highsArr.push({ index: i, price: candles[i].high });
    if (isLow) lowsArr.push({ index: i, price: candles[i].low });
  }
  return { highs: highsArr, lows: lowsArr };
}

// ---- Market structure classification ---------------------------------------
// Returns { trend: 'up'|'down'|'range', mss: 'bullish'|'bearish'|null, detail }
function marketStructure(candles, span = 2) {
  const { highs, lows } = swings(candles, span);
  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'range', mss: null, detail: 'insufficient swings', highs, lows };
  }
  const h1 = highs[highs.length - 2].price;
  const h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price;
  const l2 = lows[lows.length - 1].price;

  const higherHighs = h2 > h1;
  const higherLows = l2 > l1;
  const lowerHighs = h2 < h1;
  const lowerLows = l2 < l1;

  let trend = 'range';
  if (higherHighs && higherLows) trend = 'up';
  else if (lowerHighs && lowerLows) trend = 'down';

  // Market Structure Shift: latest close breaks the prior opposing swing.
  const lastClose = candles[candles.length - 1].close;
  const lastSwingHigh = highs[highs.length - 1].price;
  const lastSwingLow = lows[lows.length - 1].price;
  let mss = null;
  // Bullish MSS: in a down/range context, close breaks the most recent swing high.
  if (lastClose > lastSwingHigh && (trend === 'down' || trend === 'range')) mss = 'bullish';
  // Bearish MSS: in an up/range context, close breaks the most recent swing low.
  if (lastClose < lastSwingLow && (trend === 'up' || trend === 'range')) mss = 'bearish';

  return {
    trend,
    mss,
    detail: { higherHighs, higherLows, lowerHighs, lowerLows, lastSwingHigh, lastSwingLow },
    highs,
    lows,
  };
}

// ---- Fair Value Gaps --------------------------------------------------------
// A 3-candle imbalance. Bullish: low[i] > high[i-2]. Bearish: high[i] < low[i-2].
// We return recent gaps that are still at least partially unfilled, plus whether
// price is currently retesting one, and detect Inversion FVGs (invalidated gaps).
function fairValueGaps(candles, lookback = 60) {
  const start = Math.max(2, candles.length - lookback);
  const gaps = [];
  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    // Bullish FVG
    if (c.low > a.high) {
      gaps.push({ type: 'bullish', top: c.low, bottom: a.high, index: i });
    }
    // Bearish FVG
    if (c.high < a.low) {
      gaps.push({ type: 'bearish', top: a.low, bottom: c.high, index: i });
    }
  }

  const lastClose = candles[candles.length - 1].close;
  const lastHigh = candles[candles.length - 1].high;
  const lastLow = candles[candles.length - 1].low;

  // Determine fill / inversion status for each gap based on subsequent price.
  const enriched = gaps.map((g) => {
    let inverted = false;
    for (let k = g.index + 1; k < candles.length; k++) {
      const cl = candles[k].close;
      if (g.type === 'bullish' && cl < g.bottom) inverted = true; // bullish gap failed
      if (g.type === 'bearish' && cl > g.top) inverted = true; // bearish gap failed
    }
    // effective type after inversion (IFVG flips polarity)
    const effectiveType = inverted ? (g.type === 'bullish' ? 'bearish' : 'bullish') : g.type;
    return { ...g, inverted, effectiveType };
  });

  // Is price currently inside a gap (retest)?
  const retest = enriched.find(
    (g) => lastLow <= g.top && lastHigh >= g.bottom
  ) || null;

  return { gaps: enriched, retest, lastClose };
}

// ---- Liquidity Sweep / Swing Failure Pattern --------------------------------
// Looks at the last (just-closed) candle: does it pierce a recent swing level
// with a long wick but close back inside, ideally on above-average volume?
function liquiditySweep(candles, opts = {}) {
  const span = opts.span || 2;
  const volAvg = opts.volAvg || null; // average volume for spike comparison
  const n = candles.length;
  if (n < 6) return null;
  const { highs, lows } = swings(candles.slice(0, n - 1), span); // swings before last candle
  const last = candles[n - 1];
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const range = last.high - last.low || 1e-9;

  const volSpike = volAvg ? last.volume > volAvg * 1.3 : false;

  // Bullish sweep: pierced below a recent swing low but closed back above it,
  // with a dominant lower wick (rejection of sell-side liquidity).
  const recentLow = lows.length ? lows[lows.length - 1].price : null;
  if (
    recentLow != null &&
    last.low < recentLow &&
    last.close > recentLow &&
    lowerWick > body &&
    lowerWick / range > 0.5
  ) {
    return {
      type: 'bullish',
      sweptLevel: recentLow,
      wickExtreme: last.low,
      volSpike,
      strength: (lowerWick / range) + (volSpike ? 0.5 : 0),
    };
  }

  // Bearish sweep: pierced above a recent swing high but closed back below it.
  const recentHigh = highs.length ? highs[highs.length - 1].price : null;
  if (
    recentHigh != null &&
    last.high > recentHigh &&
    last.close < recentHigh &&
    upperWick > body &&
    upperWick / range > 0.5
  ) {
    return {
      type: 'bearish',
      sweptLevel: recentHigh,
      wickExtreme: last.high,
      volSpike,
      strength: (upperWick / range) + (volSpike ? 0.5 : 0),
    };
  }

  return null;
}

// ---- Equal highs / lows (liquidity pools) -----------------------------------
function equalLevels(candles, span = 2, tolerancePct = 0.0008) {
  const { highs, lows } = swings(candles, span);
  const equalHighs = [];
  const equalLows = [];
  for (let i = 1; i < highs.length; i++) {
    if (Math.abs(highs[i].price - highs[i - 1].price) / highs[i].price < tolerancePct) {
      equalHighs.push(highs[i].price);
    }
  }
  for (let i = 1; i < lows.length; i++) {
    if (Math.abs(lows[i].price - lows[i - 1].price) / lows[i].price < tolerancePct) {
      equalLows.push(lows[i].price);
    }
  }
  return { equalHighs, equalLows };
}

module.exports = {
  swings,
  marketStructure,
  fairValueGaps,
  liquiditySweep,
  equalLevels,
};
```

## `lib/engine.js`

```javascript
'use strict';

// ============================================================================
// engine.js — the decision brain.
// Combines deterministic indicators + SMC into a single UP/DOWN verdict using
// weighted confluence, following the priority from the methodology:
//   price action / SMC first, oscillators as confirmation.
// Output is the strict 5-step format:
//   { directie, interval, justificare, incredere, invalidare, ... }
// Every number comes from real candles; nothing is invented.
// ============================================================================

const ind = require('./indicators');
const smc = require('./smc');

// ---- RSI divergence (regular) ----------------------------------------------
function rsiDivergence(candles, rsiSeries, span = 2) {
  const { highs, lows } = smc.swings(candles, span);
  const out = { bullish: false, bearish: false };
  if (highs.length >= 2) {
    const a = highs[highs.length - 2];
    const b = highs[highs.length - 1];
    const ra = rsiSeries[a.index];
    const rb = rsiSeries[b.index];
    if (ra != null && rb != null && b.price > a.price && rb < ra) out.bearish = true;
  }
  if (lows.length >= 2) {
    const a = lows[lows.length - 2];
    const b = lows[lows.length - 1];
    const ra = rsiSeries[a.index];
    const rb = rsiSeries[b.index];
    if (ra != null && rb != null && b.price < a.price && rb > ra) out.bullish = true;
  }
  return out;
}

// Analyze one timeframe and return { signals, snapshot }.
function analyzeTimeframe(candles, tf, kindOfTf) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const rsi14 = ind.rsi(closes, 14) || [];
  const macd = ind.macd(closes) || { macd: [], signal: [], histogram: [] };
  const bb = ind.bollinger(closes, 20, 2) || { upper: [], mid: [], lower: [], bandwidth: [] };
  const ema9 = ind.ema(closes, 9) || [];
  const ema20 = ind.ema(closes, 20) || [];
  const ema50 = ind.ema(closes, 50) || [];
  const volAvg = ind.volumeAverage(volumes, 20) || [];
  const vwapSeries = ind.vwap(candles, 96) || [];

  const iLast = candles.length - 1;
  const price = closes[iLast];
  const rsiNow = ind.last(rsi14);
  const rsiPrev = rsi14[iLast - 1];
  const macdNow = macd.macd[iLast];
  const macdSigNow = macd.signal[iLast];
  const histNow = macd.histogram[iLast];
  const histPrev = macd.histogram[iLast - 1];
  const bbUpper = ind.last(bb.upper);
  const bbLower = ind.last(bb.lower);
  const bbMid = ind.last(bb.mid);
  const bwNow = ind.last(bb.bandwidth);
  const ema20Now = ind.last(ema20);
  const ema20Prev = ema20[iLast - 5] ?? ema20[iLast - 1];
  const ema50Now = ind.last(ema50);
  const vNow = volumes[iLast];
  const vAvgNow = ind.last(volAvg);
  const vwapNow = ind.last(vwapSeries);
  const vwapPrev = vwapSeries[iLast - 5] ?? vwapSeries[iLast - 1];

  const structure = smc.marketStructure(candles, 2);
  const fvg = smc.fairValueGaps(candles, 60);
  const sweep = smc.liquiditySweep(candles, { span: 2, volAvg: vAvgNow });
  const div = rsiDivergence(candles, rsi14, 2);

  // Bollinger squeeze: current bandwidth near the minimum of the last 40 bars.
  const bwWindow = bb.bandwidth.slice(-40).filter((v) => v != null);
  const bwMin = bwWindow.length ? Math.min(...bwWindow) : null;
  const isSqueeze = bwNow != null && bwMin != null && bwNow <= bwMin * 1.25;

  const signals = [];
  const add = (side, weight, label, kind) => signals.push({ side, weight, label, kind, tf });

  // ---------- SMC (highest priority) ----------
  if (sweep) {
    const w = 3 + Math.min(1.5, sweep.strength);
    add(sweep.type === 'bullish' ? 'up' : 'down', w, `Liquidity sweep ${sweep.type} (respingere${sweep.volSpike ? ' + volum ridicat' : ''})`, 'fast');
  }
  if (fvg.retest) {
    const g = fvg.retest;
    const t = g.effectiveType;
    add(t === 'bullish' ? 'up' : 'down', 2.5 + (g.inverted ? 0.5 : 0), `Retestare ${g.inverted ? 'IFVG' : 'FVG'} ${t}`, 'structural');
  }
  if (structure.mss === 'bullish') add('up', 2.2, 'Market Structure Shift bullish (CHoCH)', 'fast');
  if (structure.mss === 'bearish') add('down', 2.2, 'Market Structure Shift bearish (CHoCH)', 'fast');
  if (structure.trend === 'up') add('up', 1.5, 'Structură de trend ascendent (HH/HL)', 'structural');
  if (structure.trend === 'down') add('down', 1.5, 'Structură de trend descendent (LH/LL)', 'structural');

  // EMA alignment + pullback
  if (ema20Now != null && ema50Now != null) {
    const rising = ema20Prev != null && ema20Now > ema20Prev;
    const falling = ema20Prev != null && ema20Now < ema20Prev;
    if (ema20Now > ema50Now && rising) {
      const nearEma = Math.abs(price - ema20Now) / price < 0.0035;
      add('up', nearEma ? 1.8 : 1.0, `EMA20 > EMA50 în urcare${nearEma ? ' + preț pe suportul dinamic EMA20' : ''}`, 'structural');
    }
    if (ema20Now < ema50Now && falling) {
      const nearEma = Math.abs(price - ema20Now) / price < 0.0035;
      add('down', nearEma ? 1.8 : 1.0, `EMA20 < EMA50 în coborâre${nearEma ? ' + preț la rezistența dinamică EMA20' : ''}`, 'structural');
    }
  }

  // ---------- Oscillators (confirmation) ----------
  if (div.bullish) add('up', 2.0, 'Divergență bullish pe RSI', 'structural');
  if (div.bearish) add('down', 2.0, 'Divergență bearish pe RSI', 'structural');

  if (macdNow != null && macdSigNow != null) {
    const crossUp = macd.macd[iLast - 1] != null && macd.signal[iLast - 1] != null &&
      macd.macd[iLast - 1] <= macd.signal[iLast - 1] && macdNow > macdSigNow;
    const crossDown = macd.macd[iLast - 1] != null && macd.signal[iLast - 1] != null &&
      macd.macd[iLast - 1] >= macd.signal[iLast - 1] && macdNow < macdSigNow;
    if (crossUp) add('up', macdNow < 0 ? 1.6 : 1.1, 'Crossover MACD bullish', 'fast');
    if (crossDown) add('down', macdNow > 0 ? 1.6 : 1.1, 'Crossover MACD bearish', 'fast');
  }
  if (histNow != null && histPrev != null) {
    if (histNow < 0 && histNow > histPrev) add('up', 0.8, 'Histogramă MACD se contractă (momentum descendent slăbește)', 'fast');
    if (histNow > 0 && histNow < histPrev) add('down', 0.8, 'Histogramă MACD se contractă (momentum ascendent slăbește)', 'fast');
  }

  // Bollinger squeeze breakout
  if (isSqueeze && bbUpper != null && price > bbUpper && vAvgNow && vNow > vAvgNow * 1.5) {
    add('up', 2.5, 'Breakout din Bollinger Squeeze cu volum (expansiune)', 'fast');
  }
  if (isSqueeze && bbLower != null && price < bbLower && vAvgNow && vNow > vAvgNow * 1.5) {
    add('down', 2.5, 'Breakdown din Bollinger Squeeze cu volum (expansiune)', 'fast');
  }

  // Bollinger mean-reversion bounce (range) — only with RSI extreme confirmation
  if (bbLower != null && price <= bbLower && rsiNow != null && rsiNow < 32 && structure.trend !== 'down') {
    add('up', 1.4, 'Atingere bandă Bollinger inferioară + RSI supravândut (reversie la medie)', 'fast');
  }
  if (bbUpper != null && price >= bbUpper && rsiNow != null && rsiNow > 68 && structure.trend !== 'up' && div.bearish) {
    add('down', 1.4, 'Atingere bandă Bollinger superioară + RSI supracumpărat + divergență', 'fast');
  }

  // VWAP bias (intraday fair-value anchor)
  if (vwapNow != null) {
    const vwapRising = vwapPrev != null && vwapNow > vwapPrev;
    const vwapFalling = vwapPrev != null && vwapNow < vwapPrev;
    if (price > vwapNow && vwapRising) add('up', 1.0, 'Preț peste VWAP în urcare (bias intraday bullish)', 'structural');
    if (price < vwapNow && vwapFalling) add('down', 1.0, 'Preț sub VWAP în coborâre (bias intraday bearish)', 'structural');
  }

  // Volume absorption (stopping volume) at a low
  if (vAvgNow && vNow > vAvgNow * 1.8) {
    const c = candles[iLast];
    const lowerWick = Math.min(c.close, c.open) - c.low;
    const upperWick = c.high - Math.max(c.close, c.open);
    const body = Math.abs(c.close - c.open);
    if (lowerWick > body && lowerWick > upperWick) add('up', 1.6, 'Volum de oprire / absorbție la minim (wick inferior lung)', 'fast');
    if (upperWick > body && upperWick > lowerWick) add('down', 1.6, 'Volum de distribuție la maxim (wick superior lung)', 'fast');
  }

  const snapshot = {
    price,
    rsi: rsiNow != null ? +rsiNow.toFixed(1) : null,
    macd: macdNow != null ? +macdNow.toFixed(2) : null,
    macdSignal: macdSigNow != null ? +macdSigNow.toFixed(2) : null,
    macdHist: histNow != null ? +histNow.toFixed(2) : null,
    bbUpper: bbUpper != null ? +bbUpper.toFixed(2) : null,
    bbMid: bbMid != null ? +bbMid.toFixed(2) : null,
    bbLower: bbLower != null ? +bbLower.toFixed(2) : null,
    ema20: ema20Now != null ? +ema20Now.toFixed(2) : null,
    ema50: ema50Now != null ? +ema50Now.toFixed(2) : null,
    volume: vNow != null ? +vNow.toFixed(2) : null,
    volAvg: vAvgNow != null ? +vAvgNow.toFixed(2) : null,
    squeeze: isSqueeze,
    vwap: vwapNow != null ? +vwapNow.toFixed(2) : null,
    aboveVwap: vwapNow != null ? price > vwapNow : null,
    trend: structure.trend,
    mss: structure.mss,
    sweep: sweep ? sweep.type : null,
    fvgRetest: fvg.retest ? fvg.retest.effectiveType : null,
    divergence: div.bullish ? 'bullish' : div.bearish ? 'bearish' : null,
  };

  return { signals, snapshot, structure, sweep, fvg };
}

// ---- Combine timeframes into the final verdict ------------------------------
function decide(mtf) {
  // mtf: { '5m': candles, '15m': candles, ... }
  const tf5 = mtf['5m'];
  const tf15 = mtf['15m'];
  const analyses = [];
  if (tf5 && tf5.length >= 60) analyses.push({ tf: '5m', ...analyzeTimeframe(tf5, '5m') });
  if (tf15 && tf15.length >= 60) analyses.push({ tf: '15m', ...analyzeTimeframe(tf15, '15m') });

  const allSignals = analyses.flatMap((a) => a.signals);

  // Higher-timeframe (1h) trend alignment: trade WITH the bigger trend.
  let htfTrend = null;
  const tf60 = mtf['60m'];
  if (tf60 && tf60.length >= 60) {
    const c60 = tf60.map((c) => c.close);
    const e20 = ind.last(ind.ema(c60, 20));
    const e50 = ind.last(ind.ema(c60, 50));
    if (e20 != null && e50 != null) {
      htfTrend = e20 > e50 ? 'up' : 'down';
      allSignals.push({
        side: htfTrend,
        weight: 1.5,
        label: `Aliniere cu trendul 1h (${htfTrend === 'up' ? 'ascendent' : 'descendent'})`,
        kind: 'structural',
        tf: '1h',
      });
    }
  }

  let upScore = 0;
  let downScore = 0;
  let fastWeight = 0;
  let structWeight = 0;
  for (const s of allSignals) {
    if (s.side === 'up') upScore += s.weight;
    else downScore += s.weight;
    if (s.kind === 'fast') fastWeight += s.weight;
    else structWeight += s.weight;
  }

  const net = upScore - downScore;
  const absNet = Math.abs(net);
  let directie = 'NEUTRU';
  if (net > 0.8) directie = 'UP';
  else if (net < -0.8) directie = 'DOWN';

  // Winning-side signals only, sorted by weight.
  const side = directie === 'UP' ? 'up' : directie === 'DOWN' ? 'down' : null;
  const winning = allSignals.filter((s) => s.side === side).sort((a, b) => b.weight - a.weight);
  const confluence = winning.length;

  // ---- QUALITY GATE ----------------------------------------------------------
  // The edge is in genuine TRIGGER events (sweep, squeeze breakout, structure
  // shift, FVG retest, divergence, absorption), NOT in the mere existence of a
  // trend/EMA alignment. On a 10/30-min horizon, "context only" is ~coin-flip.
  // If the winning side has no trigger, we stand down (NEUTRU = no trade).
  const TRIGGER_RE = /sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band/i;
  let noTrigger = false;
  let hasTrigger = false;
  if (directie !== 'NEUTRU') {
    hasTrigger = winning.some((s) => TRIGGER_RE.test(s.label));
    if (!hasTrigger) {
      directie = 'NEUTRU';
      noTrigger = true;
    }
  }

  // Interval: dominated by fast vs structural among winning signals.
  let winFast = 0;
  let winStruct = 0;
  for (const s of winning) {
    if (s.kind === 'fast') winFast += s.weight;
    else winStruct += s.weight;
  }
  const interval = directie === 'NEUTRU' ? '30 minute' : winFast >= winStruct ? '10 minute' : '30 minute';

  // Confidence.
  let incredere = 'Scăzut';
  if (directie !== 'NEUTRU') {
    if (absNet >= 4.5 && confluence >= 3) incredere = 'Ridicat';
    else if (absNet >= 2.5 && confluence >= 2) incredere = 'Mediu';
    else incredere = 'Scăzut';
  }

  // Invalidation level from the strongest structural anchor.
  const primary = analyses[0] || {};
  const price = analyses.length ? analyses[analyses.length - 1].snapshot.price : null;
  let invalidare = 'Structură neclară — fără nivel ferm de invalidare.';
  const anchorTf = tf15 && tf15.length >= 60 ? '15m' : '5m';
  const anchor = analyses.find((a) => a.tf === anchorTf) || analyses[0];
  if (anchor) {
    if (anchor.sweep && directie === 'UP') invalidare = `O închidere sub minimul wick-ului de sweep (~${anchor.sweep.wickExtreme.toFixed(2)}) invalidează scenariul.`;
    else if (anchor.sweep && directie === 'DOWN') invalidare = `O închidere peste maximul wick-ului de sweep (~${anchor.sweep.wickExtreme.toFixed(2)}) invalidează scenariul.`;
    else if (anchor.fvg.retest && directie === 'UP') invalidare = `O închidere fermă sub baza FVG (~${anchor.fvg.retest.bottom.toFixed(2)}) invalidează scenariul.`;
    else if (anchor.fvg.retest && directie === 'DOWN') invalidare = `O închidere fermă peste vârful FVG (~${anchor.fvg.retest.top.toFixed(2)}) invalidează scenariul.`;
    else if (anchor.snapshot.ema20 && directie === 'UP') invalidare = `O închidere de ${anchorTf} sub EMA20 (~${anchor.snapshot.ema20}) semnalează un shift descendent și invalidează scenariul.`;
    else if (anchor.snapshot.ema20 && directie === 'DOWN') invalidare = `O închidere de ${anchorTf} peste EMA20 (~${anchor.snapshot.ema20}) semnalează un shift ascendent și invalidează scenariul.`;
  }

  // Justification text (deterministic; Gemini may rewrite it later).
  let justificare;
  if (directie === 'NEUTRU') {
    justificare = noTrigger
      ? 'Există context direcțional (trend/EMA), dar lipsește un declanșator real (sweep, breakout din squeeze, shift de structură, retestare FVG sau divergență). Fără trigger, mișcarea pe 10/30 min este practic aleatoare — se recomandă așteptarea unui setup clar.'
      : 'Graficul este contradictoriu și lipsit de momentum direcțional clar (structură de tip "chop"). Nu există un dezechilibru major (FVG/sweep) care să impună o direcție cu probabilitate ridicată; se recomandă prudență.';
  } else {
    const top = winning.slice(0, 4).map((s) => `${s.label} (${s.tf})`);
    justificare = `Confluență ${directie} pe ${confluence} semnale. Elemente cheie: ${top.join('; ')}. ` +
      (winFast >= winStruct
        ? 'Setup-ul este de tip momentum acut, deci fereastra scurtă (10 min) captează cel mai bine mișcarea.'
        : 'Setup-ul este structural/așezat, deci se acordă spațiu de desfășurare (30 min).');
  }

  return {
    directie,
    interval,
    justificare,
    incredere,
    invalidare,
    scores: { up: +upScore.toFixed(2), down: +downScore.toFixed(2), net: +net.toFixed(2) },
    confluence,
    signals: winning.map((s) => ({ label: s.label, tf: s.tf, weight: +s.weight.toFixed(2), kind: s.kind })),
    allSignals: allSignals.map((s) => ({ side: s.side, label: s.label, tf: s.tf, weight: +s.weight.toFixed(2) })),
    snapshots: Object.fromEntries(analyses.map((a) => [a.tf, a.snapshot])),
    htfTrend,
    price,
    ts: Date.now(),
  };
}

// ---- Sniper eligibility ----------------------------------------------------
// The A+ recipe validated out-of-sample: a liquidity sweep (ideally
// volume-confirmed) on the signal's direction, during an active session hour.
// This is the ONLY filter that survived out-of-sample testing on ETH.
function sniperEligibility(verdict, hourUTC, activeHours, requireVolume = true) {
  if (!verdict || verdict.directie === 'NEUTRU') {
    return { eligible: false, reason: 'fără direcție clară' };
  }
  const sweep = (verdict.signals || []).find((s) => /liquidity sweep/i.test(s.label));
  if (!sweep) {
    return { eligible: false, reason: 'niciun liquidity sweep pe direcția semnalului' };
  }
  if (requireVolume && !/volum ridicat/i.test(sweep.label)) {
    return { eligible: false, reason: 'sweep fără confirmare de volum' };
  }
  if (Array.isArray(activeHours) && activeHours.length && !activeHours.includes(hourUTC)) {
    return { eligible: false, reason: `în afara orelor active (acum ${hourUTC}:00 UTC)` };
  }
  return { eligible: true, reason: `Sniper A+: ${sweep.label} [${sweep.tf}]` };
}

module.exports = { decide, analyzeTimeframe, rsiDivergence, sniperEligibility };
```

## `lib/orderflow.js`

```javascript
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
```

## `lib/learning.js`

```javascript
'use strict';

// ============================================================================
// learning.js — honest, statistical self-calibration from the user's OWN journal.
// It is NOT a black-box AI. It tracks live win-rate across several context
// dimensions (setup, hour, symbol+direction, order-flow agreement) and, once a
// dimension has enough resolved samples, nudges new signals up or down based on
// how those exact conditions have actually performed for THIS user.
//
// Guards: needs a minimum sample per bucket before it trusts anything, so it
// won't "learn" from noise. It optimizes around the real edge — it does not
// invent one.
// ============================================================================

const DEFAULT_MIN_SAMPLE = 10;

function agg(arr) {
  const n = arr.length;
  const wins = arr.filter((e) => e.win).length;
  return { n, wins, winRate: n ? +((wins / n) * 100).toFixed(1) : null };
}

function bucketize(resolved, keyFn) {
  const map = {};
  for (const e of resolved) {
    const k = keyFn(e);
    if (k == null) continue;
    (map[k] = map[k] || []).push(e);
  }
  const out = {};
  for (const [k, arr] of Object.entries(map)) out[k] = agg(arr);
  return out;
}

// Build all dimension statistics from resolved journal entries.
function analyze(entries) {
  const resolved = entries.filter((e) => e.status === 'resolved');
  return {
    total: resolved.length,
    bySetup: bucketize(resolved, (e) => e.setup || 'necunoscut'),
    byHour: bucketize(resolved, (e) => (e.hourUTC != null ? `h${e.hourUTC}` : null)),
    bySymbolDir: bucketize(resolved, (e) => `${e.symbol}-${e.directie}`),
    byOfAgree: bucketize(resolved, (e) => (e.ofAgree ? `of:${e.ofAgree}` : null)),
    byInterval: bucketize(resolved, (e) => e.interval),
  };
}

// Evaluate a new signal's context against learned stats.
// Returns { estimate, adjustment, ready, factors } where estimate is a blended
// win-rate guess (%) and adjustment is (estimate - 50).
function evaluate(entries, ctx, minSample = DEFAULT_MIN_SAMPLE) {
  const a = analyze(entries);
  const factors = [];
  const pull = (map, key, label) => {
    const o = map[key];
    if (o && o.n >= minSample && o.winRate != null) {
      factors.push({ label, winRate: o.winRate, n: o.n });
    }
  };
  pull(a.bySetup, ctx.setup || 'necunoscut', `setup ${ctx.setup || '—'}`);
  if (ctx.hourUTC != null) pull(a.byHour, `h${ctx.hourUTC}`, `ora ${ctx.hourUTC} UTC`);
  pull(a.bySymbolDir, `${ctx.symbol}-${ctx.directie}`, `${ctx.symbol} ${ctx.directie}`);
  if (ctx.ofAgree) pull(a.byOfAgree, `of:${ctx.ofAgree}`, `order flow ${ctx.ofAgree}`);

  if (!factors.length) {
    return { ready: false, estimate: null, adjustment: 0, factors: [], note: 'încă strâng date — nimic învățat sigur' };
  }
  // Weight each factor by its sample size (more data = more trust).
  let wsum = 0;
  let acc = 0;
  for (const f of factors) {
    const w = Math.min(f.n, 60); // cap influence of any single bucket
    acc += f.winRate * w;
    wsum += w;
  }
  const estimate = +(acc / wsum).toFixed(1);
  const adjustment = +(estimate - 50).toFixed(1);
  return {
    ready: true,
    estimate,
    adjustment,
    factors,
    note: `estimare din istoricul tău: ${estimate}% (din ${factors.length} tipare)`,
  };
}

// Human-readable summary for the UI: best/worst learned buckets.
function summary(entries, minSample = DEFAULT_MIN_SAMPLE) {
  const a = analyze(entries);
  const rows = [];
  const collect = (map, prefix) => {
    for (const [k, o] of Object.entries(map)) {
      if (o.n >= minSample && o.winRate != null) {
        rows.push({ key: `${prefix}: ${k}`, winRate: o.winRate, n: o.n });
      }
    }
  };
  collect(a.bySetup, 'setup');
  collect(a.byHour, 'oră');
  collect(a.bySymbolDir, 'monedă+dir');
  collect(a.byOfAgree, 'order flow');
  collect(a.byInterval, 'fereastră');
  rows.sort((x, y) => y.winRate - x.winRate);
  return {
    total: a.total,
    ready: rows.length > 0,
    best: rows.slice(0, 5),
    worst: rows.slice(-5).reverse(),
    minSample,
  };
}

module.exports = { analyze, evaluate, summary, DEFAULT_MIN_SAMPLE };
```

## `lib/journal.js`

```javascript
'use strict';

// ============================================================================
// journal.js — automatic forward-testing log.
// Every alert is recorded with its entry price and a resolve time (entry + the
// contract window). A background resolver later fetches the price and marks
// win/loss AUTOMATICALLY. This gives a true, hands-off live win-rate — the only
// honest way to validate the strategy before risking real money.
// ============================================================================

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'journal.json');
let entries = load();

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('Journal read error:', e.message);
  }
  return [];
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.error('Journal write error:', e.message);
  }
}

// Record a new signal. Returns the created entry (or null if a duplicate).
function record(sig) {
  const horizonMin = sig.interval === '10 minute' ? 10 : 30;
  const isObs = !!sig.observation;
  // Observations are deduped per 5m candle per symbol; real alerts per timestamp.
  const id = isObs ? `obs-${sig.symbol}-${sig.candleOpen}` : `${sig.ts}-${sig.symbol}`;
  if (entries.some((e) => e.id === id)) return null;
  const entry = {
    id,
    observation: isObs, // true = background learning sample, not a real alert
    symbol: sig.symbol,
    directie: sig.directie,
    interval: sig.interval,
    incredere: sig.incredere,
    sniper: !!sig.sniper,
    // Rich context for the learning layer:
    setup: sig.setup || null,        // primary trigger category
    hourUTC: sig.hourUTC != null ? sig.hourUTC : new Date(sig.ts).getUTCHours(),
    ofState: sig.ofState || null,    // order-flow state: buy/sell/neutru
    ofAgree: sig.ofAgree || null,    // confirmă/conflict/neutru vs direction
    entryPrice: sig.price,
    entryTs: sig.ts,
    resolveTs: sig.ts + horizonMin * 60 * 1000,
    status: 'pending',
    exitPrice: null,
    win: null,
  };
  entries.unshift(entry);
  // Keep a large buffer for learning; drop oldest observation first so real
  // alerts are preserved as long as possible.
  if (entries.length > 8000) {
    const idx = entries.map((e, i) => [e, i]).reverse().find(([e]) => e.observation);
    if (idx) entries.splice(idx[1], 1);
    else entries.pop();
  }
  save();
  return entry;
}

// Resolve any pending entries whose window has elapsed, using getPrice(symbol).
async function resolvePending(getPrice) {
  const now = Date.now();
  const resolved = [];
  let changed = false;
  for (const e of entries) {
    if (e.status === 'pending' && now >= e.resolveTs) {
      try {
        const p = await getPrice(e.symbol);
        if (!Number.isFinite(p)) continue;
        e.exitPrice = p;
        e.win = e.directie === 'UP' ? p > e.entryPrice : p < e.entryPrice;
        e.status = 'resolved';
        changed = true;
        resolved.push(e);
      } catch {
        /* try again next cycle */
      }
    }
  }
  if (changed) save();
  return resolved;
}

function agg(arr) {
  const n = arr.length;
  const w = arr.filter((e) => e.win).length;
  return { n, wins: w, winRate: n ? +((w / n) * 100).toFixed(1) : null };
}

// Recent win-rate split by contract window (newest first). Used by the adaptive
// interval controller: when 10-min degrades, the engine shifts toward 30-min.
function recentByInterval(limit = 20) {
  const resolved = entries.filter((e) => e.status === 'resolved');
  const ten = resolved.filter((e) => e.interval === '10 minute').slice(0, limit);
  const thirty = resolved.filter((e) => e.interval === '30 minute').slice(0, limit);
  return { tenMin: agg(ten), thirtyMin: agg(thirty) };
}

function stats() {
  // Trade stats reflect only real alerts (not background observations).
  const resolved = entries.filter((e) => e.status === 'resolved' && !e.observation);
  const symbols = [...new Set(resolved.map((e) => e.symbol))];
  const ri = recentByInterval(20);
  return {
    overall: agg(resolved),
    sniper: agg(resolved.filter((e) => e.sniper)),
    nonSniper: agg(resolved.filter((e) => !e.sniper)),
    bySymbol: Object.fromEntries(symbols.map((s) => [s, agg(resolved.filter((e) => e.symbol === s))])),
    sniperBySymbol: Object.fromEntries(symbols.map((s) => [s, agg(resolved.filter((e) => e.symbol === s && e.sniper))])),
    byInterval: {
      '10 minute': agg(resolved.filter((e) => e.interval === '10 minute')),
      '30 minute': agg(resolved.filter((e) => e.interval === '30 minute')),
    },
    recentInterval: ri,
    pending: entries.filter((e) => e.status === 'pending').length,
    total: entries.length,
  };
}

function recent(limit = 40) {
  // Only show real alerts in the journal list, not background observations.
  return entries.filter((e) => !e.observation).slice(0, limit);
}

function reset() {
  entries = [];
  save();
}

module.exports = { record, resolvePending, stats, recent, recentByInterval, reset, all: () => entries };
```

## `lib/gemini.js`

```javascript
'use strict';

// ============================================================================
// gemini.js — OPTIONAL narrator / second-opinion layer.
// It is fed the NUMBERS the deterministic engine already computed (never an
// image), and asked to (a) rewrite the justification in natural Romanian and
// (b) give an agreement check. It does NOT decide direction — the engine does.
// If disabled or on any error, the engine's own text is used as fallback.
// ============================================================================

function buildPrompt(symbol, verdict) {
  const snap = JSON.stringify(verdict.snapshots, null, 0);
  const sig = verdict.signals.map((s) => `- ${s.label} [${s.tf}] pondere ${s.weight}`).join('\n');
  return `Ești un analist tehnic crypto sobru și onest. Un motor determinist a analizat ${symbol} pentru un contract event-futures (UP/DOWN pe 10 sau 30 minute) și a produs verdictul de mai jos DEJA. Rolul tău NU este să schimbi direcția, ci să:
1) rescrii "justificare" într-un paragraf clar, natural, în limba română (2-4 propoziții), fără clișee și fără hype;
2) evaluezi dacă ești DE ACORD cu direcția pe baza numerelor (acord: "da"/"partial"/"nu");
3) semnalezi orice risc imediat (ex. RSI extrem, chop, posibil whipsaw).

Verdict motor:
- Direcție: ${verdict.directie}
- Interval: ${verdict.interval}
- Încredere: ${verdict.incredere}
- Scoruri: up=${verdict.scores.up} down=${verdict.scores.down} net=${verdict.scores.net}
- Semnale care susțin direcția:
${sig || '(niciunul)'}
- Snapshot indicatori pe timeframe: ${snap}

Răspunde STRICT în JSON valid, fără text în plus, cu forma:
{"justificare": "...", "acord": "da|partial|nu", "risc": "...", "comentariu": "..."}`;
}

async function narrate(symbol, verdict, cfg) {
  if (!cfg || !cfg.enabled || !cfg.apiKey) {
    return { used: false };
  }
  const model = cfg.model || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: buildPrompt(symbol, verdict) }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 500, responseMimeType: 'application/json' },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { used: false, error: `HTTP ${res.status} ${t.slice(0, 150)}` };
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed) return { used: false, error: 'unparseable AI response' };
    return { used: true, ...parsed };
  } catch (e) {
    return { used: false, error: String(e.message || e) };
  }
}

// Quick key test used by the UI "Test AI key" button.
async function testKey(cfg) {
  if (!cfg || !cfg.apiKey) return { ok: false, error: 'no key' };
  const model = cfg.model || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Raspunde cu un singur cuvant: ok' }] }] }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 150)}` };
    }
    return { ok: true, model };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { narrate, testKey, buildPrompt };
```

## `lib/backtest.js`

```javascript
'use strict';

// ============================================================================
// backtest.js — honest, walk-forward evaluation of the engine.
// Replays real MEXC history candle-by-candle. At each 5m step it rebuilds the
// exact multi-timeframe view the live engine would have seen, gets the verdict,
// then checks the outcome after the contract window (10 or 30 min).
// Reports win-rate broken down by confidence level. No look-ahead.
// ============================================================================

const binance = require('./binance');
const engine = require('./engine');

const WINDOW = 200;         // candles fed to the engine
const HORIZON_10 = 2;       // 2 x 5m = 10 min
const HORIZON_30 = 6;       // 6 x 5m = 30 min

// Map a raw signal label to a setup category (for per-setup win-rate).
function categorize(label) {
  const l = label.toLowerCase();
  if (l.includes('sweep')) return 'Liquidity Sweep';
  if (l.includes('squeeze')) return 'Bollinger Squeeze breakout';
  if (l.includes('structure shift')) return 'Market Structure Shift';
  if (l.includes('ifvg')) return 'Inversion FVG retest';
  if (l.includes('fvg')) return 'FVG retest';
  if (l.includes('divergen')) return 'RSI divergence';
  if (l.includes('crossover')) return 'MACD crossover';
  if (l.includes('absorb') || l.includes('distribu')) return 'Volume absorption';
  if (l.includes('reversie') || l.includes('band')) return 'Bollinger bounce';
  return 'other';
}

const TRIGGER_RE = /sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band/i;

async function run(symbol, opts = {}) {
  const days = Math.min(60, Math.max(3, opts.days || 15));
  const endDaysAgo = Math.max(0, opts.endDaysAgo || 0);
  const endTimeMs = endDaysAgo > 0 ? Date.now() - endDaysAgo * 86400 * 1000 : null;
  const tf5 = await binance.fetchHistory(symbol, '5m', days, 1000, endTimeMs);
  const tf15 = await binance.fetchHistory(symbol, '15m', days, 1000, endTimeMs);

  const stats = {
    symbol,
    source: 'binance.vision (proxy pentru istoric adânc)',
    days,
    totalCandles: tf5.length,
    evaluated: 0,
    byConfidence: {
      Ridicat: { n: 0, wins: 0 },
      Mediu: { n: 0, wins: 0 },
      Scăzut: { n: 0, wins: 0 },
    },
    byDirection: { UP: { n: 0, wins: 0 }, DOWN: { n: 0, wins: 0 } },
    bySetup: {},        // primary trigger category -> {n, wins}
    strong: { n: 0, wins: 0 },   // only |net| >= 5 (rare, high-conviction)
    veryStrong: { n: 0, wins: 0 }, // only |net| >= 7
    byHour: {},         // UTC hour -> {n, wins}  (all signals)
    sweepAll: { n: 0, wins: 0 },
    sweepActiveHours: { n: 0, wins: 0 }, // sweep during EU/US session windows
    sniper: { n: 0, wins: 0 },  // sweep + active hours + volume-confirmed
    trades: [],
  };

  // High-liquidity windows (UTC): EU open + US open, matching a morning/evening
  // routine for an EET (UTC+2/+3) trader.
  const ACTIVE_HOURS = new Set([6, 7, 8, 9, 13, 14, 15, 16, 17]);

  const maxHorizon = HORIZON_30;
  let lastCountedIdx = -999;

  for (let i = WINDOW; i < tf5.length - maxHorizon; i++) {
    const window5 = tf5.slice(i - WINDOW, i + 1);
    const currentCloseTime = tf5[i].closeTime;
    const window15 = tf15.filter((c) => c.closeTime <= currentCloseTime).slice(-WINDOW);
    if (window15.length < 60) continue;

    let verdict;
    try {
      verdict = engine.decide({ '5m': window5, '15m': window15 });
    } catch {
      continue;
    }
    if (verdict.directie === 'NEUTRU') continue;

    // Avoid heavily overlapping duplicate signals: enforce a small cooldown.
    if (i - lastCountedIdx < 2) continue;
    lastCountedIdx = i;

    const horizon = verdict.interval === '10 minute' ? HORIZON_10 : HORIZON_30;
    const outIdx = i + horizon;
    if (outIdx >= tf5.length) continue;

    const entry = tf5[i].close;
    const exit = tf5[outIdx].close;
    const win = verdict.directie === 'UP' ? exit > entry : exit < entry;

    stats.evaluated++;
    const conf = verdict.incredere;
    if (stats.byConfidence[conf]) {
      stats.byConfidence[conf].n++;
      if (win) stats.byConfidence[conf].wins++;
    }
    stats.byDirection[verdict.directie].n++;
    if (win) stats.byDirection[verdict.directie].wins++;

    // Per-setup: use the highest-weight TRIGGER signal on the winning side.
    const primaryTrigger = (verdict.signals || []).find((s) => TRIGGER_RE.test(s.label));
    let isSweep = false;
    let sweepVolConfirmed = false;
    if (primaryTrigger) {
      const cat = categorize(primaryTrigger.label);
      if (!stats.bySetup[cat]) stats.bySetup[cat] = { n: 0, wins: 0 };
      stats.bySetup[cat].n++;
      if (win) stats.bySetup[cat].wins++;
      isSweep = cat === 'Liquidity Sweep';
      sweepVolConfirmed = isSweep && /volum ridicat/i.test(primaryTrigger.label);
    }

    // Hour-of-day (UTC) breakdown.
    const hour = new Date(tf5[i].openTime).getUTCHours();
    if (!stats.byHour[hour]) stats.byHour[hour] = { n: 0, wins: 0 };
    stats.byHour[hour].n++;
    if (win) stats.byHour[hour].wins++;

    const inActive = ACTIVE_HOURS.has(hour);
    if (isSweep) {
      stats.sweepAll.n++; if (win) stats.sweepAll.wins++;
      if (inActive) { stats.sweepActiveHours.n++; if (win) stats.sweepActiveHours.wins++; }
      // "Sniper": the full A+ recipe — sweep + volume + active session window.
      if (inActive && sweepVolConfirmed) { stats.sniper.n++; if (win) stats.sniper.wins++; }
    }

    // Strong-conviction filters (selectivity test).
    const absNet = Math.abs(verdict.scores.net);
    if (absNet >= 5) { stats.strong.n++; if (win) stats.strong.wins++; }
    if (absNet >= 7) { stats.veryStrong.n++; if (win) stats.veryStrong.wins++; }

    if (stats.trades.length < 200) {
      stats.trades.push({
        time: new Date(tf5[i].openTime).toISOString(),
        directie: verdict.directie,
        interval: verdict.interval,
        incredere: conf,
        entry: +entry.toFixed(2),
        exit: +exit.toFixed(2),
        win,
      });
    }
  }

  // Win-rate percentages.
  const pct = (o) => (o.n ? +((o.wins / o.n) * 100).toFixed(1) : null);
  stats.winRate = {
    overall: pct({
      n: stats.evaluated,
      wins: Object.values(stats.byConfidence).reduce((s, o) => s + o.wins, 0),
    }),
    Ridicat: pct(stats.byConfidence.Ridicat),
    Mediu: pct(stats.byConfidence.Mediu),
    Scăzut: pct(stats.byConfidence.Scăzut),
    UP: pct(stats.byDirection.UP),
    DOWN: pct(stats.byDirection.DOWN),
    strong: pct(stats.strong),
    veryStrong: pct(stats.veryStrong),
    sweepAll: pct(stats.sweepAll),
    sweepActiveHours: pct(stats.sweepActiveHours),
    sniper: pct(stats.sniper),
  };
  stats.hourWinRate = Object.fromEntries(
    Object.entries(stats.byHour)
      .map(([h, v]) => [h, { winRate: pct(v), n: v.n }])
      .sort((a, b) => Number(a[0]) - Number(b[0]))
  );
  stats.setupWinRate = Object.fromEntries(
    Object.entries(stats.bySetup)
      .map(([k, v]) => [k, { winRate: pct(v), n: v.n }])
      .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0))
  );

  return stats;
}

module.exports = { run };
```

## `lib/binance.js`

```javascript
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
```

## `public/index.html`

```html
<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SignalPilot — MEXC live UP/DOWN</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <header>
    <div class="brand">
      <span class="logo">📈</span>
      <div>
        <h1>SignalPilot</h1>
        <p>Analiză MEXC în timp real → decizii UP/DOWN pe 10/30 min (indicatori + Smart Money, determinist)</p>
      </div>
    </div>
    <div class="badges">
      <span id="sessionBadge" class="badge badge-off">Sesiune: ...</span>
      <span id="aiBadge" class="badge badge-off">AI: verific...</span>
      <span id="connBadge" class="badge badge-off">Conectare...</span>
    </div>
  </header>

  <main>
    <!-- LIVE SIGNAL CARDS -->
    <section class="panel">
      <div class="panel-head">
        <h2>Semnale live</h2>
        <label class="switch-inline">
          <input type="checkbox" id="soundToggle" checked /> sunet la alertă
        </label>
      </div>
      <div class="howto">
        <b>Cum se folosește:</b> aplicația citește prețul MEXC live și îl analizează singură (nu desenează grafic — îți dă direct concluzia).
        În <b>Sniper Mode</b>, aștepți banner-ul verde/roșu <b>🎯 INTRĂ</b>: atunci deschizi MEXC → event futures pe moneda respectivă și pui <b>UP</b> sau <b>DOWN</b> pe fereastra afișată (10 sau 30 min). Cât timp vezi <b>⏳ AȘTEAPTĂ</b>, nu faci nimic. Fereastra (10 vs 30 min) o alege singură în funcție de tipul setup-ului.
      </div>
      <div id="cards" class="cards"></div>
    </section>

    <!-- ALERTS FEED -->
    <section class="panel">
      <div class="panel-head"><h2>Alerte (setup-uri bune)</h2><button id="clearAlerts" class="btn-ghost">golește</button></div>
      <div id="alerts" class="alerts"><p class="muted">Aștept primul setup care depășește pragul de încredere...</p></div>
    </section>

    <!-- LIVE JOURNAL (AUTO) -->
    <section class="panel">
      <div class="panel-head">
        <h2>📒 Jurnal live (automat)</h2>
        <button id="resetJournal" class="btn-ghost">resetează</button>
      </div>
      <p class="muted" style="margin-top:-6px">Fiecare alertă e înregistrată automat, iar rezultatul (WIN/LOSS) se verifică singur după 10/30 min. Acesta e win-rate-ul TĂU real, live.</p>
      <div id="journalStats" class="bt-result" style="margin-top:12px"></div>
      <div id="journalList" class="journal-list"></div>
    </section>

    <!-- LEARNING -->
    <section class="panel">
      <div class="panel-head"><h2>🧠 Ce a învățat (din rezultatele tale)</h2></div>
      <p class="muted" style="margin-top:-6px">Pe măsură ce jurnalul se umple, aplicația învață ce tipare îți merg și ce evită. Are nevoie de minim ~10 semnale per tipar ca să aibă încredere.</p>
      <div id="learningBody" class="learning-body">
        <p class="muted">Încă strâng date — nimic învățat sigur deocamdată. Lasă aplicația să ruleze câteva sesiuni.</p>
      </div>
    </section>

    <!-- SETTINGS -->
    <section class="panel">
      <div class="panel-head"><h2>Setări</h2><button id="toggleSettings" class="btn-ghost">arată / ascunde</button></div>
      <div id="settingsBody" class="settings">
        <div class="grid">
          <div class="field">
            <label>Simboluri (unul pe linie, format MEXC ex. BTCUSDT)</label>
            <textarea id="symbols" rows="3">BTCUSDT
ETHUSDT</textarea>
          </div>
          <div class="field">
            <label>Interval scanare (secunde)</label>
            <input type="number" id="scanInterval" min="3" value="8" />
            <label>Alertă de la încrederea (doar în mod normal)</label>
            <select id="alertMinConfidence">
              <option>Scăzut</option>
              <option selected>Mediu</option>
              <option>Ridicat</option>
            </select>
          </div>
        </div>
        <hr />
        <div class="sniper-panel">
          <label class="switch-inline"><input type="checkbox" id="sniperMode" checked /> <b>🎯 Sniper Mode</b> — alertează DOAR pe setup-ul A+ (liquidity sweep + volum + ore active). Recomandat.</label>
          <div class="grid" style="margin-top:12px">
            <div class="field">
              <label>Ore active (ora TA locală, separate prin virgulă)</label>
              <input type="text" id="activeHoursLocal" placeholder="ex: 9,10,11,16,17,18,19" />
              <small class="muted" id="hoursHint"></small>
            </div>
            <div class="field">
              <label class="switch-inline"><input type="checkbox" id="sniperRequireVolume" checked /> cere confirmare de volum pe sweep</label>
              <small class="muted">În afara Sniper Mode, aplicația alertează pe orice setup peste pragul de încredere (mai multe semnale, mai mult zgomot).</small>
            </div>
          </div>
          <div class="grid" style="margin-top:12px">
            <div class="field">
              <label class="switch-inline"><input type="checkbox" id="adaptiveInterval" /> <b>Comută 10→30 min când payout-ul pe 10 min e slab</b> (opțional)</label>
              <small class="muted">Intervalul e ales natural de tipul setup-ului (sweep rapid → 10 min, structură → 30 min), deci apar AMBELE. Payout-ul de mai jos e afișat mereu ca informație. Bifează asta doar dacă vrei ca aplicația să treacă singură pe 30 min când 10 min are payout prost.</small>
            </div>
            <div class="field">
              <label>Payout MEXC pe 10 min (%)</label>
              <input type="number" id="payout10" min="1" max="500" value="65" />
              <label>Payout MEXC pe 30 min (%)</label>
              <input type="number" id="payout30" min="1" max="500" value="82" />
          </div>
        </div>
        <div class="grid" style="margin-top:12px">
            <div class="field">
              <label class="switch-inline"><input type="checkbox" id="useOrderFlow" checked /> <b>Order flow live</b> — confirmă direcția cu order book + agresiunea tranzacțiilor</label>
              <label class="switch-inline"><input type="checkbox" id="requireOfAgree" /> nu alerta când order flow e în conflict cu direcția</label>
            </div>
            <div class="field">
              <label class="switch-inline"><input type="checkbox" id="useLearning" checked /> <b>🧠 Învățare din jurnal</b> — se calibrează din rezultatele tale și blochează tiparele pierzătoare</label>
              <small class="muted">Are nevoie de minim ~10 semnale per tipar înainte să acționeze.</small>
            </div>
        </div>
        <hr />
        <div class="grid">
          <div class="field">
            <label class="switch-inline"><input type="checkbox" id="geminiEnabled" /> Folosește Gemini pentru justificarea alertelor 🎯 (opțional)</label>
            <label>Cheie API Gemini</label>
            <input type="password" id="geminiKey" placeholder="lipește cheia (rămâne locală, pe mașina ta)" />
            <label>Model Gemini</label>
            <select id="geminiModel">
              <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (cel mai ieftin)</option>
              <option value="gemini-3.5-flash" selected>gemini-3.5-flash (recomandat)</option>
              <option value="gemini-3.1-pro">gemini-3.1-pro (cel mai scump)</option>
            </select>
            <small class="muted" id="costHint"></small>
          </div>
          <div class="field field-actions">
            <button id="testAi" class="btn-secondary">Testează cheia AI</button>
            <span id="testAiResult" class="muted"></span>
          </div>
        </div>
        <div class="save-row">
          <button id="saveSettings" class="btn-primary">Salvează setările</button>
          <span id="saveResult" class="muted"></span>
        </div>
      </div>
    </section>

    <!-- BACKTEST -->
    <section class="panel">
      <div class="panel-head"><h2>Backtest (win-rate real pe istoric)</h2></div>
      <div class="backtest-controls">
        <select id="btSymbol"></select>
        <select id="btDays">
          <option value="7">ultimele 7 zile</option>
          <option value="15" selected>ultimele 15 zile</option>
          <option value="30">ultimele 30 zile</option>
        </select>
        <button id="runBacktest" class="btn-primary">Rulează backtest</button>
        <span id="btStatus" class="muted"></span>
      </div>
      <div id="btResult" class="bt-result"></div>
      <p class="disclaimer">⚠️ Backtest-ul măsoară strict dacă prețul a închis în direcția prezisă după fereastra contractului, pe date istorice recente. Rezultatele trecute NU garantează rezultate viitoare. Comisioanele/spread-ul platformei nu sunt incluse. Tranzacționarea contractelor pe 10/30 min este speculativă și riscantă.</p>
    </section>
  </main>

  <script src="app.js"></script>
</body>
</html>
```

## `public/app.js`

```javascript
'use strict';

// SignalPilot frontend: subscribes to SSE, renders live cards + alerts,
// handles settings save, AI key test, and backtest.

const $ = (id) => document.getElementById(id);
const cardsEl = $('cards');
const alertsEl = $('alerts');
let cards = {}; // symbol -> element
let soundOn = true;
let SNIPER_MODE = true; // set from server config on load
let ACTIVE_HOURS = [6, 7, 8, 9, 13, 14, 15, 16, 17]; // UTC, set from config
const detailsOpen = {}; // per-symbol: keep the analysis panel open across live re-renders

function updateSessionBadge() {
  const nowUtc = new Date().getUTCHours();
  const active = ACTIVE_HOURS.includes(nowUtc);
  const el = $('sessionBadge');
  if (!el) return;
  if (active) {
    el.textContent = '🟢 Sesiune ACTIVĂ';
    el.className = 'badge badge-on';
  } else {
    // find next active hour
    let next = null;
    for (let k = 1; k <= 24; k++) {
      const h = (nowUtc + k) % 24;
      if (ACTIVE_HOURS.includes(h)) { next = k; break; }
    }
    el.textContent = next != null ? `⚪ Pauză (sesiune în ~${next}h)` : '⚪ Pauză';
    el.className = 'badge badge-off';
  }
}

// Local <-> UTC hour conversion (offset in hours; e.g. UTC+3 => off = -3).
const OFF = new Date().getTimezoneOffset() / 60;
const localToUtc = (h) => (((h + OFF) % 24) + 24) % 24;
const utcToLocal = (h) => (((h - OFF) % 24) + 24) % 24;

// ---------- rendering ----------
function fmt(n) {
  if (n === null || n === undefined) return '—';
  return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n;
}

function snapChips(snaps) {
  const parts = [];
  for (const [tf, s] of Object.entries(snaps || {})) {
    parts.push(`<span>${tf} · RSI ${fmt(s.rsi)}</span>`);
    parts.push(`<span>${tf} · trend ${s.trend}</span>`);
    if (s.sweep) parts.push(`<span>${tf} · sweep ${s.sweep}</span>`);
    if (s.fvgRetest) parts.push(`<span>${tf} · FVG ${s.fvgRetest}</span>`);
    if (s.divergence) parts.push(`<span>${tf} · div ${s.divergence}</span>`);
    if (s.squeeze) parts.push(`<span>${tf} · squeeze</span>`);
    if (s.aboveVwap != null) parts.push(`<span>${tf} · ${s.aboveVwap ? 'peste' : 'sub'} VWAP</span>`);
  }
  return parts.join('');
}

function ofRow(v) {
  const parts = [];
  if (v.orderflow) {
    const of = v.orderflow;
    const map = { buy: '🟢 cumpărare', sell: '🔴 vânzare', neutru: '⚪ neutru' };
    const agreeMap = { 'confirmă': '<span class="ok">✓ confirmă</span>', 'conflict': '<span class="bad">✗ conflict</span>', 'neutru': 'neutru' };
    parts.push(`<span title="dezechilibru order book + agresiune tranzacții">Order flow: <b>${map[of.state] || of.state}</b> (${(of.pressure * 100).toFixed(0)}%) · ${agreeMap[v.ofAgree] || ''}</span>`);
  }
  if (v.learned && v.learned.ready) {
    const cls = v.learned.estimate >= 55 ? 'ok' : (v.learned.estimate < 48 ? 'bad' : '');
    parts.push(`<span title="estimare din istoricul tău">🧠 istoric: <span class="${cls}">${v.learned.estimate}%</span></span>`);
  }
  if (v.htfTrend) {
    const up = v.htfTrend === 'up';
    parts.push(`<span title="trendul pe 1 oră">Trend 1h: <b class="${up ? 'ok' : 'bad'}">${up ? '↗ ascendent' : '↘ descendent'}</b></span>`);
  }
  if (v.suppressed) parts.push(`<span class="bad">⛔ blocat: ${v.suppressed}</span>`);
  if (!parts.length) return '';
  return `<div class="of-row">${parts.join(' &nbsp;·&nbsp; ')}</div>`;
}

function renderCard(v) {
  const dir = v.directie.toLowerCase();
  const eligible = v.sniper && v.sniper.eligible;
  const sigs = (v.signals || []).slice(0, 5).map((s) => `<li>${s.label} <span class="muted">[${s.tf}]</span></li>`).join('');
  const ai = v.ai
    ? `<div class="ai-note">🤖 <b>AI (${v.ai.acord || '—'})</b>: ${v.ai.risc ? '⚠️ ' + v.ai.risc : ''} ${v.ai.comentariu || ''}</div>`
    : (v.aiError ? `<div class="ai-note">🤖 AI indisponibil: ${v.aiError}</div>` : '');

  // The BIG banner: the only thing you act on. Sniper Mode = trade only on 🎯.
  const ev = v.ev;
  const payoutNow = ev ? (v.interval === '10 minute' ? ev.payout10 : ev.payout30) : null;
  const beNow = ev ? (v.interval === '10 minute' ? ev.breakEven10 : ev.breakEven30) : null;
  const evWarn = ev && !ev.positive;
  const evNote = ev ? ` · payout ${payoutNow}% (break-even ${beNow}%)` : '';
  const warnLine = evWarn ? `<div class="ev-warn">⚠️ payout prea mic pentru edge-ul tău — EV negativ, mai bine sari peste</div>` : '';
  let banner;
  if (SNIPER_MODE) {
    banner = eligible
      ? `<div class="cta go ${dir}">🎯 INTRĂ ${v.directie} ${v.directie === 'UP' ? '▲' : '▼'}<div class="cta-sub">MEXC event futures · fereastră ${v.interval}${evNote}</div></div>${warnLine}`
      : `<div class="cta wait">⏳ AȘTEAPTĂ<div class="cta-sub">nu e încă setup A+: ${v.sniper ? v.sniper.reason : '—'}</div></div>`;
  } else {
    banner = `<div class="cta go ${dir}">${v.directie} ${v.directie === 'UP' ? '▲' : v.directie === 'DOWN' ? '▼' : ''}<div class="cta-sub">fereastră ${v.interval}${evNote} · încredere ${v.incredere}</div></div>${warnLine}`;
  }

  return `
    <div class="card-top">
      <span class="card-sym">${v.symbol}</span>
      <span class="card-price">${fmt(v.price)} USDT</span>
    </div>
    ${banner}
    ${ofRow(v)}
    <details class="analysis" data-sym="${v.symbol}" ${detailsOpen[v.symbol] ? 'open' : ''}>
      <summary>Analiza motorului în timp real (context, nu semnal de intrare)</summary>
      <div class="row5">
        <b>Direcție motor</b><span class="dir-inline ${dir}">${v.directie} · ${v.interval}</span>
        <b>Încredere</b><span><span class="pill ${v.incredere}">${v.incredere}</span> <span class="muted">(net ${v.scores.net})</span></span>
        <b>Justificare</b><span>${v.justificare}</span>
        <b>Invalidare</b><span>${v.invalidare}</span>
        ${ev ? `<b>EV / fereastră</b><span>10 min: <span class="${ev.ev10 > 0 ? 'dir-inline up' : 'dir-inline down'}">${ev.ev10 > 0 ? '+' : ''}${ev.ev10}%</span> (payout ${ev.payout10}%, nevoie ${ev.breakEven10}%) · 30 min: <span class="${ev.ev30 > 0 ? 'dir-inline up' : 'dir-inline down'}">${ev.ev30 > 0 ? '+' : ''}${ev.ev30}%</span> (payout ${ev.payout30}%, nevoie ${ev.breakEven30}%)</span>` : ''}
      </div>
      ${sigs ? `<ul class="sig-list">${sigs}</ul>` : ''}
      ${ai}
      <div class="snap">${snapChips(v.snapshots)}</div>
    </details>
    <div class="muted" style="margin-top:8px;font-size:11px">preț live · actualizat ${new Date(v.ts).toLocaleTimeString('ro-RO')}</div>
  `;
}

function upsertCard(v) {
  let el = cards[v.symbol];
  if (!el) {
    el = document.createElement('div');
    el.className = 'card';
    cardsEl.appendChild(el);
    cards[v.symbol] = el;
  }
  el.className = 'card ' + v.directie.toLowerCase();
  el.innerHTML = renderCard(v);
  // Persist the analysis panel's open/closed state across live re-renders.
  const det = el.querySelector('details.analysis');
  if (det) {
    det.addEventListener('toggle', () => { detailsOpen[v.symbol] = det.open; });
  }
}

function addAlert(a) {
  if (alertsEl.querySelector('.muted')) alertsEl.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'alert-item flash';
  const dir = a.directie.toLowerCase();
  el.innerHTML = `
    <span class="adir ${dir}">${a.sniper ? '🎯 ' : ''}${a.directie} ${a.directie === 'UP' ? '▲' : '▼'}</span>
    <span><b>${a.symbol}</b> · ${a.interval} · <span class="pill ${a.incredere}">${a.incredere}</span> @ ${fmt(a.price)}</span>
    <span class="alert-time">${new Date(a.ts).toLocaleTimeString('ro-RO')}</span>
  `;
  alertsEl.prepend(el);
  while (alertsEl.children.length > 50) alertsEl.removeChild(alertsEl.lastChild);
  notify(a);
}

// ---------- notifications ----------
function beep() {
  if (!soundOn) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.start(); o.stop(ctx.currentTime + 0.4);
  } catch { /* ignore */ }
}

function notify(a) {
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`SignalPilot: ${a.symbol} ${a.directie}`, {
      body: `${a.interval} · încredere ${a.incredere} @ ${fmt(a.price)}`,
    });
  }
}

// ---------- SSE ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => setBadge('connBadge', 'Live', true));
  es.addEventListener('error', () => setBadge('connBadge', 'Reconectare...', false));
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    Object.values(d.latest || {}).forEach(upsertCard);
    if (d.journal) renderJournal(d.journal);
    if (d.learning) renderLearning(d.learning);
    (d.alerts || []).slice().reverse().forEach((a) => {
      // render without sound on initial load
      if (alertsEl.querySelector('.muted')) alertsEl.innerHTML = '';
      const el = document.createElement('div');
      el.className = 'alert-item';
      const dir = a.directie.toLowerCase();
      el.innerHTML = `<span class="adir ${dir}">${a.directie} ${a.directie === 'UP' ? '▲' : '▼'}</span>
        <span><b>${a.symbol}</b> · ${a.interval} · <span class="pill ${a.incredere}">${a.incredere}</span> @ ${fmt(a.price)}</span>
        <span class="alert-time">${new Date(a.ts).toLocaleTimeString('ro-RO')}</span>`;
      alertsEl.prepend(el);
    });
  });
  es.addEventListener('signal', (e) => upsertCard(JSON.parse(e.data)));
  es.addEventListener('alert', (e) => addAlert(JSON.parse(e.data)));
  es.addEventListener('journal', (e) => {
    const d = JSON.parse(e.data);
    renderJournal(d);
    if (d.learning) renderLearning(d.learning);
  });
}

// ---------- learning panel ----------
function renderLearning(l) {
  if (!l) return;
  const el = $('learningBody');
  if (!l.ready) {
    el.innerHTML = `<p class="muted">Încă strâng date (${l.total || 0} semnale rezolvate). Am nevoie de minim ${l.minSample || 10} per tipar ca să învăț ceva sigur.</p>`;
    return;
  }
  const row = (r) => {
    const cls = r.winRate >= 55 ? 'ok' : (r.winRate < 48 ? 'bad' : '');
    return `<div class="lrow"><span>${r.key}</span><span class="${cls}"><b>${r.winRate}%</b> <span class="muted">(${r.n})</span></span></div>`;
  };
  el.innerHTML = `
    <div class="learn-cols">
      <div><div class="learn-h ok">✅ Ce îți merge</div>${(l.best || []).map(row).join('') || '<p class="muted">—</p>'}</div>
      <div><div class="learn-h bad">⛔ Ce evită</div>${(l.worst || []).map(row).join('') || '<p class="muted">—</p>'}</div>
    </div>
    <p class="muted" style="margin-top:10px">Din ${l.total} semnale rezolvate. Aplicația folosește asta ca să confirme sau să blocheze semnale noi automat.</p>`;
}

// ---------- live journal ----------
function wr(o) {
  return o && o.n ? `${o.winRate}% <span class="muted">(${o.wins}/${o.n})</span>` : '<span class="muted">—</span>';
}
function renderJournal(d) {
  if (!d || !d.stats) return;
  const s = d.stats;
  const box = (val, lbl) => `<div class="bt-box"><div class="big" style="font-size:20px">${val}</div><div class="lbl">${lbl}</div></div>`;
  let html = box(wr(s.overall), 'general (toate)') + box(wr(s.sniper), '🎯 doar Sniper') + `<div class="bt-box"><div class="big" style="font-size:20px">${s.pending}</div><div class="lbl">în așteptare</div></div>`;
  if (s.byInterval) {
    html += box(wr(s.byInterval['10 minute']), 'fereastră 10 min') + box(wr(s.byInterval['30 minute']), 'fereastră 30 min');
  }
  if (s.recentInterval && s.recentInterval.tenMin && s.recentInterval.tenMin.n) {
    html += box(wr(s.recentInterval.tenMin), '10 min (recent 20)');
  }
  for (const [sym, o] of Object.entries(s.sniperBySymbol || {})) {
    if (o.n) html += box(wr(o), `🎯 ${sym}`);
  }
  $('journalStats').innerHTML = html;

  const rows = (d.recent || []).map((e) => {
    const st = e.status === 'pending'
      ? '<span class="muted">⏳ în așteptare</span>'
      : (e.win ? '<span class="adir up">✓ WIN</span>' : '<span class="adir down">✗ LOSS</span>');
    const dir = e.directie === 'UP' ? '▲' : '▼';
    const exit = e.exitPrice != null ? fmt(e.exitPrice) : '—';
    return `<div class="jrow">
      <span>${e.sniper ? '🎯 ' : ''}<b>${e.symbol}</b> ${dir}</span>
      <span class="muted">${e.interval}</span>
      <span>${fmt(e.entryPrice)} → ${exit}</span>
      <span>${st}</span>
      <span class="alert-time">${new Date(e.entryTs).toLocaleString('ro-RO')}</span>
    </div>`;
  }).join('');
  $('journalList').innerHTML = rows || '<p class="muted">Niciun semnal încă. Când apare o alertă, apare aici automat și se rezolvă singură după 10/30 min.</p>';
}

function setBadge(id, text, on) {
  const el = $(id);
  el.textContent = text;
  el.className = 'badge ' + (on ? 'badge-on' : 'badge-off');
}

// ---------- Gemini cost estimate ----------
// Prices per 1M tokens (input / output), USD, as of mid-2026.
const MODEL_PRICING = {
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.50 },
  'gemini-3.5-flash': { in: 1.50, out: 9.00 },
  'gemini-3.1-pro': { in: 2.00, out: 12.00 },
};
const TOK_IN = 1000;   // ~ prompt size per signal
const TOK_OUT = 400;   // ~ JSON response per signal
function updateCostHint() {
  const model = $('geminiModel').value;
  const p = MODEL_PRICING[model];
  if (!p) { $('costHint').textContent = ''; return; }
  const perSignal = (TOK_IN / 1e6) * p.in + (TOK_OUT / 1e6) * p.out;
  const perMonth20 = perSignal * 20 * 30; // ~20 alerte/zi
  $('costHint').textContent = `Cost ≈ $${perSignal.toFixed(4)}/semnal · ≈ $${perMonth20.toFixed(2)}/lună la ~20 alerte 🎯/zi (se apelează DOAR pe alerte, nu la fiecare scanare).`;
}

// ---------- settings ----------
async function loadState() {
  const r = await fetch('/api/state');
  const s = await r.json();
  const c = s.config;
  $('symbols').value = (c.symbols || []).join('\n');
  $('scanInterval').value = c.scanIntervalSec;
  $('alertMinConfidence').value = c.alertMinConfidence;
  SNIPER_MODE = c.sniperMode !== false;
  if (Array.isArray(c.activeHoursUTC) && c.activeHoursUTC.length) ACTIVE_HOURS = c.activeHoursUTC;
  updateSessionBadge();
  $('sniperMode').checked = c.sniperMode !== false;
  $('sniperRequireVolume').checked = !!c.sniperRequireVolume;
  $('adaptiveInterval').checked = c.adaptiveInterval !== false;
  if (c.payout10) $('payout10').value = c.payout10;
  if (c.payout30) $('payout30').value = c.payout30;
  $('useOrderFlow').checked = c.useOrderFlow !== false;
  $('requireOfAgree').checked = !!c.requireOfAgree;
  $('useLearning').checked = c.useLearning !== false;
  const localHours = (c.activeHoursUTC || []).map(utcToLocal).sort((a, b) => a - b);
  $('activeHoursLocal').value = localHours.join(',');
  const nowUtc = new Date().getUTCHours();
  $('hoursHint').textContent = `Acum e ora ${nowUtc}:00 UTC. Orele active implicite acoperă deschiderea pieței europene și americane (cele mai lichide).`;
  $('geminiEnabled').checked = !!c.gemini.enabled;
  if (c.gemini.model) $('geminiModel').value = c.gemini.model;
  updateCostHint();
  if (c.gemini.apiKey) $('geminiKey').placeholder = 'cheie salvată (••••) — scrie pentru a înlocui';
  setBadge('aiBadge', c.gemini.enabled && c.gemini.apiKey ? 'AI: Gemini activ' : 'AI: dezactivat', c.gemini.enabled && c.gemini.apiKey);
  // populate backtest symbol select
  const sel = $('btSymbol');
  sel.innerHTML = (c.symbols || []).map((s) => `<option>${s}</option>`).join('');
}

async function saveSettings() {
  const symbols = $('symbols').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const localHours = $('activeHoursLocal').value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
  const activeHoursUTC = localHours.map(localToUtc);
  const body = {
    symbols,
    scanIntervalSec: Number($('scanInterval').value),
    alertMinConfidence: $('alertMinConfidence').value,
    sniperMode: $('sniperMode').checked,
    sniperRequireVolume: $('sniperRequireVolume').checked,
    adaptiveInterval: $('adaptiveInterval').checked,
    payout10: Number($('payout10').value),
    payout30: Number($('payout30').value),
    useOrderFlow: $('useOrderFlow').checked,
    requireOfAgree: $('requireOfAgree').checked,
    useLearning: $('useLearning').checked,
    activeHoursUTC,
    gemini: {
      enabled: $('geminiEnabled').checked,
      model: $('geminiModel').value,
      apiKey: $('geminiKey').value,
    },
  };
  $('saveResult').textContent = 'se salvează...';
  const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  $('saveResult').textContent = d.ok ? '✓ salvat' : 'eroare';
  $('geminiKey').value = '';
  loadState();
  setTimeout(() => ($('saveResult').textContent = ''), 3000);
}

async function testAi() {
  $('testAiResult').textContent = 'testez...';
  const body = { apiKey: $('geminiKey').value, model: $('geminiModel').value };
  const r = await fetch('/api/test-ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  $('testAiResult').textContent = d.ok ? `✓ cheie validă (${d.model})` : `✗ ${d.error}`;
}

// ---------- backtest ----------
async function runBacktest() {
  const symbol = $('btSymbol').value;
  const days = $('btDays').value;
  $('btStatus').textContent = 'rulez pe istoric... (câteva secunde)';
  $('btResult').innerHTML = '';
  try {
    const r = await fetch(`/api/backtest?symbol=${symbol}&days=${days}`);
    const d = await r.json();
    if (d.error) { $('btStatus').textContent = 'eroare: ' + d.error; return; }
    $('btStatus').textContent = `${d.evaluated} semnale evaluate pe ${d.totalCandles} lumânări (${d.days} zile, sursă: ${d.source})`;
    const w = d.winRate;
    const box = (big, lbl) => `<div class="bt-box"><div class="big">${big ?? '—'}${big != null ? '%' : ''}</div><div class="lbl">${lbl}</div></div>`;
    $('btResult').innerHTML =
      box(w.overall, 'win-rate general') +
      box(w.Ridicat, `încredere Ridicat (${d.byConfidence.Ridicat.n})`) +
      box(w.Mediu, `încredere Mediu (${d.byConfidence.Mediu.n})`) +
      box(w.Scăzut, `încredere Scăzut (${d.byConfidence.Scăzut.n})`) +
      box(w.UP, `semnale UP (${d.byDirection.UP.n})`) +
      box(w.DOWN, `semnale DOWN (${d.byDirection.DOWN.n})`);
  } catch (e) {
    $('btStatus').textContent = 'eroare: ' + e.message;
  }
}

// ---------- wire up ----------
$('toggleSettings').addEventListener('click', () => $('settingsBody').classList.toggle('open'));
$('saveSettings').addEventListener('click', saveSettings);
$('testAi').addEventListener('click', testAi);
$('runBacktest').addEventListener('click', runBacktest);
$('clearAlerts').addEventListener('click', () => { alertsEl.innerHTML = '<p class="muted">golit.</p>'; });
$('soundToggle').addEventListener('change', (e) => { soundOn = e.target.checked; });
$('geminiModel').addEventListener('change', updateCostHint);
$('resetJournal').addEventListener('click', async () => {
  if (!confirm('Sigur resetezi jurnalul? Se pierde istoricul de semnale.')) return;
  await fetch('/api/journal/reset', { method: 'POST' });
});

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

loadState();
connect();
updateSessionBadge();
setInterval(updateSessionBadge, 60000);
```

## `public/style.css`

```css
:root {
  --bg: #0d1117;
  --panel: #161b22;
  --panel2: #1c2330;
  --border: #2a3240;
  --text: #e6edf3;
  --muted: #8b949e;
  --up: #16c784;
  --down: #ea3943;
  --neutral: #c9a227;
  --accent: #6d5efc;
  --accent2: #b14bff;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  color: #fff;
}
.brand { display: flex; align-items: center; gap: 14px; }
.logo { font-size: 34px; }
header h1 { margin: 0; font-size: 22px; }
header p { margin: 2px 0 0; font-size: 12.5px; opacity: 0.92; }
.badges { display: flex; gap: 8px; }
.badge { padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; background: rgba(255,255,255,0.15); }
.badge-on { background: #0b8a4d; }
.badge-off { background: rgba(0,0,0,0.25); }

main { max-width: 1100px; margin: 22px auto; padding: 0 20px 60px; display: flex; flex-direction: column; gap: 18px; }

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.panel-head h2 { margin: 0; font-size: 16px; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.card { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 16px; border-left: 5px solid var(--muted); }
.card.up { border-left-color: var(--up); }
.card.down { border-left-color: var(--down); }
.card.neutru { border-left-color: var(--neutral); }
.card-top { display: flex; align-items: baseline; justify-content: space-between; }
.card-sym { font-size: 18px; font-weight: 700; }
.card-price { font-size: 14px; color: var(--muted); }
.dir { font-size: 30px; font-weight: 800; margin: 8px 0 2px; }
.dir.up { color: var(--up); }
.dir.down { color: var(--down); }
.dir.neutru { color: var(--neutral); }
.row5 { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 13px; margin-top: 8px; }
.row5 b { color: var(--muted); font-weight: 600; }
.pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
.pill.Ridicat { background: rgba(22,199,132,0.18); color: var(--up); }
.pill.Mediu { background: rgba(201,162,39,0.18); color: var(--neutral); }
.pill.Scăzut { background: rgba(139,148,158,0.18); color: var(--muted); }
.sig-list { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
.sig-list li { margin: 2px 0; }
.snap { margin-top: 10px; font-size: 11.5px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 8px; }
.snap span { background: rgba(255,255,255,0.04); padding: 2px 7px; border-radius: 6px; }
.ai-note { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: rgba(109,94,252,0.12); font-size: 12.5px; }

.alerts { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto; }
.alert-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; background: var(--panel2); border: 1px solid var(--border); font-size: 13px; }
.alert-item .adir { font-weight: 800; }
.alert-item .adir.up { color: var(--up); }
.alert-item .adir.down { color: var(--down); }
.alert-time { margin-left: auto; color: var(--muted); font-size: 11px; }

.settings { display: none; }
.settings.open { display: block; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 12.5px; color: var(--muted); }
.field-actions { justify-content: flex-start; gap: 10px; }
input, textarea, select { background: #0d1117; border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 9px 11px; font-size: 13px; font-family: inherit; }
textarea { resize: vertical; }
.switch-inline { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 13px; }
hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
.save-row { margin-top: 16px; display: flex; align-items: center; gap: 12px; }

.btn-primary { background: linear-gradient(90deg, var(--accent), var(--accent2)); color: #fff; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 700; cursor: pointer; }
.btn-secondary { background: var(--panel2); color: var(--text); border: 1px solid var(--border); padding: 9px 16px; border-radius: 8px; cursor: pointer; }
.btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); padding: 5px 12px; border-radius: 8px; cursor: pointer; font-size: 12px; }
button:hover { filter: brightness(1.1); }

.muted { color: var(--muted); font-size: 12.5px; }
.disclaimer { color: var(--muted); font-size: 11.5px; margin-top: 14px; line-height: 1.5; }
.backtest-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 14px; }
.bt-result { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.bt-box { background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; text-align: center; }
.bt-box .big { font-size: 24px; font-weight: 800; }
.bt-box .lbl { font-size: 12px; color: var(--muted); margin-top: 4px; }
.flash { animation: flash 1s ease; }
@keyframes flash { 0% { background: rgba(109,94,252,0.35); } 100% { background: var(--panel2); } }


/* Sniper mode */
.sniper-status { margin: 6px 0 4px; font-size: 12px; padding: 5px 10px; border-radius: 8px; background: rgba(139,148,158,0.12); color: var(--muted); }
.sniper-status.ok { background: rgba(22,199,132,0.18); color: var(--up); font-weight: 700; }
.sniper-panel { background: rgba(109,94,252,0.08); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.sniper-panel small { display: block; margin-top: 6px; line-height: 1.4; }


/* Live journal */
.journal-list { margin-top: 14px; display: flex; flex-direction: column; gap: 4px; max-height: 360px; overflow-y: auto; }
.jrow { display: grid; grid-template-columns: 1.2fr 0.8fr 1.4fr 0.9fr 1.3fr; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 8px; background: var(--panel2); border: 1px solid var(--border); font-size: 12.5px; }
.jrow .adir.up { color: var(--up); font-weight: 700; }
.jrow .adir.down { color: var(--down); font-weight: 700; }
@media (max-width: 640px) { .jrow { grid-template-columns: 1fr 1fr; } }


/* Big call-to-action banner (the only thing you act on) */
.cta { text-align: center; border-radius: 12px; padding: 18px 12px; margin: 10px 0; font-size: 26px; font-weight: 800; letter-spacing: 0.5px; }
.cta .cta-sub { font-size: 12px; font-weight: 500; opacity: 0.9; margin-top: 6px; letter-spacing: 0; }
.cta.wait { background: rgba(139,148,158,0.12); color: var(--muted); border: 1px dashed var(--border); }
.cta.go.up { background: rgba(22,199,132,0.16); color: var(--up); border: 1px solid var(--up); }
.cta.go.down { background: rgba(234,57,67,0.16); color: var(--down); border: 1px solid var(--down); }
.cta.go.neutru { background: rgba(201,162,39,0.14); color: var(--neutral); border: 1px solid var(--neutral); }
.cta.go { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(22,199,132,0.0); } 50% { box-shadow: 0 0 0 4px rgba(22,199,132,0.10); } }
.analysis { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 8px; }
.analysis summary { cursor: pointer; font-size: 12px; color: var(--muted); user-select: none; }
.analysis summary:hover { color: var(--text); }
.dir-inline { font-weight: 700; }
.dir-inline.up { color: var(--up); }
.dir-inline.down { color: var(--down); }
.dir-inline.neutru { color: var(--neutral); }


.howto { background: rgba(109,94,252,0.10); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; font-size: 12.5px; line-height: 1.55; color: var(--text); margin-bottom: 14px; }


.ev-warn { margin-top: 6px; padding: 8px 12px; border-radius: 8px; background: rgba(234,57,67,0.15); color: var(--down); font-size: 12.5px; font-weight: 600; text-align: center; }


/* Order flow row on cards */
.of-row { margin: 6px 0; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.04); font-size: 11.5px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px; }
.of-row .ok { color: var(--up); font-weight: 700; }
.of-row .bad { color: var(--down); font-weight: 700; }

/* Learning panel */
.learn-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 640px) { .learn-cols { grid-template-columns: 1fr; } }
.learn-h { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
.learn-h.ok { color: var(--up); }
.learn-h.bad { color: var(--down); }
.lrow { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; border-radius: 8px; background: var(--panel2); border: 1px solid var(--border); font-size: 12.5px; margin-bottom: 4px; }
.lrow .ok { color: var(--up); }
.lrow .bad { color: var(--down); }
```
