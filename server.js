'use strict';

// ============================================================================
// SignalPilot server — always-on local app (PinPilot style).
// Serves the UI at http://localhost:3001, polls MEXC, runs the engine on a
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

// Port 3001 by default so SignalPilot can run alongside PinPilot (which uses 3000).
const PORT = process.env.PORT || 3001;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  scanIntervalSec: 8,
  alertMinConfidence: 'Mediu',
  // Sniper mode: only act on the out-of-sample-validated A+ setup
  // (liquidity sweep + volume + active session hours). Alerts fire only on these.
  sniperMode: true,
  sniperRequireVolume: true,
  activeHoursUTC: [6, 7, 8, 9, 13, 14, 15, 16, 17],
  // Adaptive interval: mirror the trader — when the recent 10-min win-rate
  // degrades, shift new signals to the 30-min window (more time, less noise).
  adaptiveInterval: true,
  adaptive10minThreshold: 45, // if recent 10-min win-rate < this (%) => use 30-min
  adaptiveMinSamples: 8,      // need at least this many resolved 10-min trades first
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
  const mtf = await mexc.fetchMultiTimeframe(symbol, ['5m', '15m'], 200);
  const verdict = engine.decide(mtf);
  verdict.symbol = symbol;

  // Adaptive interval: if recent 10-min trades are underperforming, push new
  // 10-min signals to the 30-min window (exactly what the trader does).
  if (config.adaptiveInterval && verdict.interval === '10 minute') {
    const ten = journal.recentByInterval(20).tenMin;
    if (ten.n >= config.adaptiveMinSamples && ten.winRate != null && ten.winRate < config.adaptive10minThreshold) {
      verdict.interval = '30 minute';
      verdict.intervalAdapted = { from: '10 minute', reason: `10 min recent la ${ten.winRate}% (< ${config.adaptive10minThreshold}%) → trec pe 30 min`, recent10: ten };
    }
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
  if (shouldAlert) {
    const alert = {
      symbol,
      directie: verdict.directie,
      interval: verdict.interval,
      incredere: verdict.incredere,
      price: verdict.price,
      justificare: verdict.justificare,
      sniper: !!(verdict.sniper && verdict.sniper.eligible),
      ts: verdict.ts,
    };
    alerts.unshift(alert);
    if (alerts.length > 50) alerts.pop();
    // Auto-journal every alert for hands-off forward testing.
    const logged = journal.record({ ...alert });
    broadcast('alert', alert);
    if (logged) broadcast('journal', { stats: journal.stats(), recent: journal.recent(40) });
    console.log(`[ALERT${alert.sniper ? ' 🎯 SNIPER' : ''}] ${symbol}: ${verdict.directie} ${verdict.interval} (${verdict.incredere}) @ ${verdict.price}`);
  }
  return verdict;
}

// Background resolver: closes out pending journal entries automatically.
async function resolveJournal() {
  try {
    const resolved = await journal.resolvePending((sym) => mexc.fetchPrice(sym));
    if (resolved.length) {
      broadcast('journal', { stats: journal.stats(), recent: journal.recent(40) });
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
  });
});

app.get('/api/journal', (req, res) => {
  res.json({ stats: journal.stats(), recent: journal.recent(100) });
});

app.post('/api/journal/reset', (req, res) => {
  journal.reset();
  broadcast('journal', { stats: journal.stats(), recent: journal.recent(40) });
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
  if (body.adaptive10minThreshold != null) {
    const t = Number(body.adaptive10minThreshold);
    if (t >= 30 && t <= 60) config.adaptive10minThreshold = t;
  }
  if (Array.isArray(body.activeHoursUTC)) {
    config.activeHoursUTC = body.activeHoursUTC
      .map((h) => Number(h))
      .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
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
  res.write(`event: snapshot\ndata: ${JSON.stringify({ latest, alerts, journal: { stats: journal.stats(), recent: journal.recent(40) } })}\n\n`);
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// ---- Boot -------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log('====================================================');
  console.log('  SignalPilot — MEXC live UP/DOWN engine');
  console.log('====================================================');
  console.log(`  Running at http://localhost:${PORT}`);
  console.log(`  AI (Gemini): ${config.gemini.enabled && config.gemini.apiKey ? 'ENABLED' : 'disabled'}`);
  console.log(`  Symbols: ${config.symbols.join(', ')}`);
  console.log('  (Deschide singur in browser? Acceseaza linkul de mai sus.)');
  console.log('====================================================');
  const ok = await mexc.ping().catch(() => false);
  console.log(ok ? '  MEXC reachable: OK' : '  WARNING: MEXC not reachable from this machine.');
  startScheduler();
  startResolver();
  if (process.env.NO_OPEN !== '1') openBrowser(`http://localhost:${PORT}`);
});
