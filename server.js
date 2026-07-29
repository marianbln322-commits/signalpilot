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
const cal = require('./lib/calibration');

// Port 3005 by default so it runs alongside PinPilot (3004) and older
// SignalPilot versions (3001/3002). Override with the PORT env var if needed.
const PORT = process.env.PORT || 3005;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CALIBRATION_PATH = path.join(__dirname, 'calibration.json');
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
  // Event-futures EV gate. A signal is only actionable when its CALIBRATED
  // probability clears the break-even imposed by the payout, with a cushion.
  // Break-even = 1/(1+payout): 65% payout needs 60.6%, 82% payout needs 54.9%.
  requireEvGate: true,   // never alert on a signal whose EV is not provably positive
  evMarginPct: 1.5,      // required cushion above break-even
  calibrationMinSample: 30, // resolved outcomes needed before a bucket is trusted
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
let calModel = loadCalibration();
const latest = {};          // symbol -> last verdict
const alerts = [];          // recent alert feed
const sseClients = new Set();
// (symbol -> barCloseTime) of the last bar we already acted on. The engine now
// produces one verdict per CLOSED bar, so alerting is keyed to the bar rather
// than to the poll: previously the same bar was re-evaluated every 8 seconds.
const lastActedBar = {};
let scanning = false;       // re-entrancy guard for the scheduler

function loadCalibration() {
  try {
    if (fs.existsSync(CALIBRATION_PATH)) {
      const m = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
      console.log(`Calibration loaded: ${m.total} rezultate, fitted ${new Date(m.fittedAt).toISOString()}`);
      return m;
    }
  } catch (e) {
    console.error('Calibration read error:', e.message);
  }
  return null;
}

function saveCalibration(model) {
  try {
    fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(model, null, 2));
  } catch (e) {
    console.error('Calibration write error:', e.message);
  }
}

// The live probability model blends two sources, preferring the user's own
// resolved journal once it is large enough, and falling back to the calibration
// fitted from historical backtest. If neither has enough data, we report that
// honestly instead of printing an invented number.
function buildLivePrediction(verdict) {
  const ctx = { setup: verdict.setup, interval: verdict.interval, score: verdict.score };
  const journalSamples = journal.all()
    .filter((e) => e.status === 'resolved' && e.setup && e.interval)
    .map((e) => ({ setup: e.setup, interval: e.interval, score: e.score, win: e.win }));

  if (journalSamples.length >= (config.calibrationMinSample || 30)) {
    const live = cal.fit(journalSamples, { minSample: config.calibrationMinSample });
    const p = cal.predict(live, ctx);
    if (p.ready) return { ...p, origin: 'jurnalul tău (forward-test real)' };
  }
  if (calModel) {
    const p = cal.predict(calModel, ctx);
    if (p.ready) return { ...p, origin: 'backtest istoric (calibrare)' };
  }
  return {
    ready: false,
    probability: null,
    ciLow: null,
    ciHigh: null,
    n: journalSamples.length,
    source: `nicio calibrare cu suficiente date (am ${journalSamples.length} rezultate, nevoie de ${config.calibrationMinSample || 30})`,
    origin: null,
  };
}

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

  // ---- Event-futures decision layer ----------------------------------------
  // The window comes from the primary trigger (engine). What we add here is the
  // only question that decides whether the trade is worth taking at all:
  // does the CALIBRATED probability clear the break-even imposed by the payout?
  //
  // The previous version answered this by assuming a 55% win rate whenever the
  // journal was thin (`fallbackWinRate`), then printing a confident EV computed
  // from that assumption. That is a fabricated number driving a money decision,
  // so it is gone. If there is no calibration data, the app now says so.
  if (verdict.directie !== 'NEUTRU') {
    const payoutFor = (iv) => (iv === '10 minute' ? config.payout10 : config.payout30);

    const prediction = buildLivePrediction(verdict);
    verdict.prediction = prediction;

    const gate = cal.decide(prediction, payoutFor(verdict.interval), { marginPct: config.evMarginPct });
    verdict.gate = gate;

    // Compare both windows explicitly so the trader can see the trade-off.
    const alt = verdict.interval === '10 minute' ? '30 minute' : '10 minute';
    const altPrediction = buildLivePrediction({ ...verdict, interval: alt });
    const altGate = cal.decide(altPrediction, payoutFor(alt), { marginPct: config.evMarginPct });

    verdict.ev = {
      payout10: config.payout10,
      payout30: config.payout30,
      breakEven10: cal.breakEvenWinRate(config.payout10),
      breakEven30: cal.breakEvenWinRate(config.payout30),
      chosen: verdict.interval,
      probability: prediction.probability,
      probabilitySource: prediction.origin,
      conservative: gate.conservative,
      required: gate.required,
      ev: gate.ev,
      positive: gate.trade,
      alternative: {
        interval: alt,
        probability: altPrediction.probability,
        ev: altGate.ev,
        trade: altGate.trade,
      },
    };

    // Optional: switch to the other window when it is the one with positive EV.
    if (config.adaptiveInterval && !gate.trade && altGate.trade) {
      verdict.intervalAdapted = {
        from: verdict.interval,
        reason: `EV pozitiv doar pe ${alt} la payout-urile curente`,
      };
      verdict.interval = alt;
      verdict.prediction = altPrediction;
      verdict.gate = altGate;
      verdict.ev.chosen = alt;
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

  // Sniper eligibility. Hour is taken from the BAR, not from wall-clock time, so
  // the same bar is always judged against the same session window.
  const hourUTC = verdict.barCloseTime
    ? new Date(verdict.barCloseTime).getUTCHours()
    : new Date().getUTCHours();
  verdict.sniper = engine.sniperEligibility(verdict, hourUTC, config.activeHoursUTC, config.sniperRequireVolume);
  verdict.hourUTC = hourUTC;

  // NOTE: verdict.setup now comes from the engine's single trigger taxonomy
  // (lib/engine.js TRIGGERS), so the live app, the journal and the backtest all
  // agree on what "the setup" is. It used to be re-derived here from a separate
  // copy of a regex that had drifted out of sync.

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
      journal.record({
        observation: true,
        candleOpen: verdict.barOpenTime,
        symbol,
        directie: verdict.directie,
        interval: verdict.interval,
        incredere: verdict.incredere,
        score: verdict.score,
        sniper: false,
        setup: verdict.setup,
        hourUTC,
        ofState: verdict.orderflow ? verdict.orderflow.state : null,
        ofAgree: verdict.ofAgree,
        price: verdict.price,
        // Anchor the outcome window to the BAR CLOSE, which is when the signal
        // became actionable, rather than to the moment we happened to poll.
        ts: verdict.barCloseTime || verdict.ts,
      });
    } catch { /* non-fatal */ }
  }

  latest[symbol] = verdict;
  broadcast('signal', verdict);

  // ---- Alerting: exactly once per closed bar --------------------------------
  // Verdicts are now deterministic per (symbol, barCloseTime). The old logic
  // compared each poll against the previous poll, so a bar could alert, stop
  // alerting and alert again as the forming candle wobbled.
  const barKey = verdict.barCloseTime;
  const alreadyActed = barKey != null && lastActedBar[symbol] === barKey;

  let shouldAlert;
  if (config.sniperMode) {
    shouldAlert = verdict.sniper.eligible && !alreadyActed;
  } else {
    shouldAlert = verdict.directie !== 'NEUTRU' &&
      CONF_RANK[verdict.incredere] >= CONF_RANK[config.alertMinConfidence] &&
      !alreadyActed;
  }

  // EV gate: for a binary contract, direction is not enough — the calibrated
  // probability has to beat the break-even the payout imposes. This is the
  // single most important filter for event futures, so it runs before the rest.
  if (shouldAlert && config.requireEvGate) {
    if (!verdict.gate || !verdict.gate.trade) {
      shouldAlert = false;
      verdict.suppressed = verdict.gate && verdict.gate.needsData
        ? `fără probabilitate calibrată: ${verdict.gate.reason}`
        : `EV nefavorabil: ${verdict.gate ? verdict.gate.reason : 'necunoscut'}`;
    }
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
    if (barKey != null) lastActedBar[symbol] = barKey;
    const alert = {
      symbol,
      directie: verdict.directie,
      interval: verdict.interval,
      incredere: verdict.incredere,
      setup: verdict.setup,
      probability: verdict.prediction ? verdict.prediction.probability : null,
      ev: verdict.gate ? verdict.gate.ev : null,
      price: verdict.price,
      justificare: verdict.justificare,
      sniper: !!(verdict.sniper && verdict.sniper.eligible),
      ofState: verdict.orderflow ? verdict.orderflow.state : null,
      ofAgree: verdict.ofAgree || null,
      barCloseTime: verdict.barCloseTime,
      ts: verdict.barCloseTime || verdict.ts,
    };
    alerts.unshift(alert);
    if (alerts.length > 50) alerts.pop();
    // Auto-journal every alert with rich context for the learning layer.
    const logged = journal.record({
      ...alert,
      score: verdict.score,
      hourUTC,
    });
    broadcast('alert', alert);
    if (logged) broadcast('journal', { stats: journal.stats(), recent: journal.recent(40), learning: learning.summary(journal.all()) });
    console.log(`[ALERT${alert.sniper ? ' 🎯 SNIPER' : ''}] ${symbol}: ${verdict.directie} ${verdict.interval} ${alert.probability != null ? alert.probability + '%' : 'necalibrat'} (EV ${alert.ev != null ? alert.ev + '%' : '?'}) @ ${verdict.price}`);
  }
  return verdict;
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

// Re-entrancy guard: scanAll is async but was driven by a bare setInterval, so
// a slow round (3 klines + depth + aggTrades per symbol, plus an optional AI
// call) could still be in flight when the next tick fired. Overlapping rounds
// duplicate every request, which is the fastest way to earn an exchange rate
// limit, and they can interleave writes to the journal.
async function scanAll() {
  if (scanning) return;
  scanning = true;
  try {
    for (const symbol of config.symbols) {
      try {
        await scanSymbol(symbol);
      } catch (e) {
        console.error(`Scan error ${symbol}:`, e.message);
        broadcast('error', { symbol, message: e.message });
      }
    }
  } finally {
    scanning = false;
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
  if (typeof body.requireEvGate === 'boolean') config.requireEvGate = body.requireEvGate;
  if (body.evMarginPct != null) {
    const v = Number(body.evMarginPct);
    if (v >= 0 && v <= 15) config.evMarginPct = v;
  }
  if (body.calibrationMinSample != null) {
    const v = Number(body.calibrationMinSample);
    if (v >= 10 && v <= 500) config.calibrationMinSample = v;
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
    const result = await backtest.run(symbol, {
      days,
      endDaysAgo,
      // The backtest must evaluate against the SAME payouts and the SAME EV
      // threshold the live app uses, otherwise it is grading a different rule.
      payout10: config.payout10,
      payout30: config.payout30,
      marginPct: config.evMarginPct,
      minSample: config.calibrationMinSample,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fit the live probability model from historical data and persist it.
// This is what gives the app calibrated probabilities on day one, before the
// user's own journal is large enough to speak for itself.
app.post('/api/calibrate', async (req, res) => {
  const symbols = Array.isArray(req.body?.symbols) && req.body.symbols.length
    ? req.body.symbols.map((s) => String(s).toUpperCase())
    : config.symbols;
  const days = Math.min(60, Math.max(7, Number(req.body?.days) || 30));
  try {
    const perSymbol = {};
    const allTrades = [];
    for (const sym of symbols) {
      const r = await backtest.run(sym, {
        days,
        payout10: config.payout10,
        payout30: config.payout30,
        marginPct: config.evMarginPct,
        minSample: config.calibrationMinSample,
        // Use the whole span for fitting here; honest evaluation stays in
        // /api/backtest, which keeps a held-out slice.
        trainFraction: 0.9,
      });
      if (r.error) { perSymbol[sym] = { error: r.error }; continue; }
      perSymbol[sym] = {
        evaluated: r.evaluated,
        outOfSample: r.outOfSample.all,
        byInterval: r.outOfSample.byInterval,
      };
      // Rebuild raw samples from the fitted model's own training rows is not
      // possible, so refit from the reported trades of this run.
      for (const t of r.trades) {
        allTrades.push({ setup: t.setup, interval: t.interval, score: t.score, win: t.win });
      }
    }
    if (!allTrades.length) {
      return res.status(400).json({ error: 'nu s-au produs semnale pentru calibrare' });
    }
    calModel = cal.fit(allTrades, { minSample: config.calibrationMinSample });
    calModel.symbols = symbols;
    calModel.days = days;
    saveCalibration(calModel);
    res.json({ ok: true, model: calModel, perSymbol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/calibration', (req, res) => {
  res.json(calModel || { total: 0, note: 'nicio calibrare salvată — rulează POST /api/calibrate' });
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
