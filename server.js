'use strict';

// ============================================================================
// SignalPilot server — always-on local app (PinPilot style).
// Serves the UI at http://localhost:3002, polls MEXC, runs the engine on a
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

// Port 3002 by default so this version runs alongside PinPilot (3000) and an
// older SignalPilot (3001). Override with the PORT env var if needed.
const PORT = process.env.PORT || 3002;
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
  // EV-based interval selection (mirrors the trader): pick the window whose
  // MEXC payout gives the best expected value. Break-even win-rate = 1/(1+payout).
  adaptiveInterval: true,
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
  const mtf = await mexc.fetchMultiTimeframe(symbol, ['5m', '15m'], 200);
  const verdict = engine.decide(mtf);
  verdict.symbol = symbol;

  // EV-based interval selection: choose the window with the best expected value
  // given MEXC payouts. This is what the trader did — avoid low-payout windows.
  if (config.adaptiveInterval && verdict.directie !== 'NEUTRU') {
    const ji = journal.recentByInterval(20);
    const wr10 = (ji.tenMin.n >= 8 && ji.tenMin.winRate != null) ? ji.tenMin.winRate : config.fallbackWinRate;
    const wr30 = (ji.thirtyMin.n >= 8 && ji.thirtyMin.winRate != null) ? ji.thirtyMin.winRate : config.fallbackWinRate;
    const p10 = config.payout10 / 100;
    const p30 = config.payout30 / 100;
    const evOf = (wr, p) => (wr / 100) * p - (1 - wr / 100); // per $1 staked
    const ev10 = evOf(wr10, p10);
    const ev30 = evOf(wr30, p30);
    const breakEven = (p) => +(100 / (1 + p)).toFixed(1);
    const chosen = ev30 >= ev10 ? '30 minute' : '10 minute';
    const chosenEv = chosen === '30 minute' ? ev30 : ev10;
    verdict.interval = chosen;
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
