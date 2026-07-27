'use strict';

// ============================================================================
// SignalPilot server — always-on local app (PinPilot style).
// Serves the UI at http://localhost:3010, polls MEXC, runs the engine on a
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

// Port 3010 by default. Override with the PORT environment variable when needed.
const PORT = Number(process.env.PORT) || 3010;
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
  paperStake: 10,        // simulated stake per alert; no real order is ever placed
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
  // Explicit horizon inputs: 10m reads 1m/5m/15m, 30m reads
  // 5m/15m/30m, while 60m remains higher-timeframe context.
  const mtf = await mexc.fetchMultiTimeframe(symbol, ['1m', '5m', '15m', '30m', '60m'], 200);
  const analysisTime = Date.now();
  const closedMtf = { errors: mtf.errors || {} };
  for (const timeframe of ['1m', '5m', '15m', '30m', '60m']) {
    if (Array.isArray(mtf[timeframe])) {
      closedMtf[timeframe] = mtf[timeframe].filter((candle) => candle.closeTime < analysisTime);
    }
  }
  const verdict = engine.decide(closedMtf);
  verdict.symbol = symbol;
  const liveOneMinute = Array.isArray(mtf['1m']) ? mtf['1m'] : [];
  const latestOneMinute = liveOneMinute.length ? liveOneMinute[liveOneMinute.length - 1] : null;
  verdict.chart = liveOneMinute.slice(-120);
  verdict.entryPriceFresh = !!(latestOneMinute && Number.isFinite(latestOneMinute.close) &&
    Number.isFinite(latestOneMinute.openTime) && latestOneMinute.openTime >= analysisTime - 2 * 60 * 1000);
  if (!verdict.chart.length && latest[symbol] && Array.isArray(latest[symbol].chart)) {
    verdict.chart = latest[symbol].chart;
  }
  verdict.dataErrors = mtf.errors || {};
  if (verdict.entryPriceFresh) verdict.price = latestOneMinute.close;

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
      interval: verdict.interval,
      requireInterval: true,
      calibrationVersion: 2,
    });

    // The engine emits only a technical score. A financial probability exists
    // only when canonical, exact-settlement forward observations satisfy the
    // horizon-specific minimum-sample guard. The probability is the empirical
    // win-rate itself; the technical score remains a separate ranking signal.
    for (const horizon of [10, 30]) {
      const forecast = verdict.forecasts && verdict.forecasts[horizon];
      if (!forecast || forecast.directie === 'NEUTRU') continue;
      const learned = learning.evaluate(journal.all(), {
        symbol,
        directie: forecast.directie,
        setup: forecast.reasons[0] || 'context',
        hourUTC,
        ofAgree: verdict.ofAgree,
        interval: `${horizon} minute`,
        requireInterval: true,
        calibrationVersion: 2,
      });
      forecast.learned = learned;
      if (learned.ready && learned.estimate != null) {
        const calibratedConfidence = learned.estimate / 100;
        forecast.confidence = +calibratedConfidence.toFixed(4);
        forecast.probabilityUp = +(forecast.directie === 'UP' ? calibratedConfidence : 1 - calibratedConfidence).toFixed(4);
        forecast.probabilityDown = +(1 - forecast.probabilityUp).toFixed(4);
        forecast.calibrated = true;
        forecast.reasons.push(`Calibrare jurnal: ${learned.estimate}% pe contexte similare (${learned.factors.length} factori)`);
        if (learned.estimate < config.learningSuppressBelow) {
          forecast.suppressed = `istoricul local indică doar ${learned.estimate}%`;
        }
      }
    }
  }

  // A binary contract becomes actionable only when it has an empirically
  // calibrated probability strictly above payout-specific break-even.
  for (const horizon of [10, 30]) {
    const forecast = verdict.forecasts && verdict.forecasts[horizon];
    if (!forecast) continue;
    const payoutPct = horizon === 10 ? config.payout10 : config.payout30;
    const breakEven = 1 / (1 + payoutPct / 100);
    forecast.breakEven = +breakEven.toFixed(4);
    forecast.payoutPct = payoutPct;
    forecast.expectedValue = null;
    forecast.action = 'WAIT';

    if (!forecast.calibrated || !Number.isFinite(forecast.confidence)) {
      forecast.suppressed = forecast.suppressed || 'calibrare în curs — date forward insuficiente';
      continue;
    }

    forecast.expectedValue = +(forecast.confidence * (payoutPct / 100) - (1 - forecast.confidence)).toFixed(4);
    if (!forecast.setupValid) {
      forecast.suppressed = forecast.suppressed || 'setup tehnic incomplet';
    } else if (forecast.suppressed) {
      // A learning veto set above remains authoritative.
    } else if (forecast.confidence <= breakEven) {
      forecast.suppressed = `sub break-even: ${(forecast.confidence * 100).toFixed(1)}% ≤ ${(breakEven * 100).toFixed(1)}%`;
    } else {
      forecast.action = 'TRADE';
    }
  }

  // Continuous learning: create non-overlapping observations only at exact
  // 10m/30m boundaries. Features come from closed candles, while entry uses
  // the boundary's 1m open, so labels do not leak post-entry information.
  if (config.useLearning && verdict.forecasts && Array.isArray(mtf['1m'])) {
    try {
      const now = Date.now();
      const captureWindowMs = Math.max(15000, config.scanIntervalSec * 1000 + 5000);
      for (const horizon of [10, 30]) {
        const horizonMs = horizon * 60 * 1000;
        const boundary = Math.floor(now / horizonMs) * horizonMs;
        if (now - boundary > captureWindowMs) continue;
        const entryCandle = mtf['1m'].find((candle) => candle.openTime === boundary);
        if (!entryCandle) continue;
        const boundaryMtf = { errors: mtf.errors || {} };
        for (const timeframe of ['1m', '5m', '15m', '30m', '60m']) {
          if (Array.isArray(mtf[timeframe])) {
            boundaryMtf[timeframe] = mtf[timeframe].filter((candle) => candle.closeTime < boundary);
          }
        }
        const forecast = engine.forecastHorizon(boundaryMtf, horizon);
        if (!forecast.setupValid) continue;
        journal.record({
          observation: true,
          calibrationVersion: 2,
          entrySource: 'boundary-1m-open',
          candleOpen: boundary,
          symbol,
          directie: forecast.directie,
          interval: `${horizon} minute`,
          incredere: forecast.confidence != null && forecast.confidence >= 0.68 ? 'Ridicat' : forecast.confidence != null && forecast.confidence >= 0.58 ? 'Mediu' : 'Scăzut',
          probability: forecast.confidence,
          sniper: false,
          setup: forecast.reasons[0] || 'context',
          hourUTC,
          ofState: verdict.orderflow ? verdict.orderflow.state : null,
          ofAgree: verdict.ofAgree,
          price: entryCandle.open,
          ts: boundary,
          stake: 0,
          payoutPct: horizon === 10 ? config.payout10 : config.payout30,
        });
      }
    } catch { /* non-fatal */ }
  }

  const prev = latest[symbol];

  // The selected forecast is the single execution authority for UI, SSE and
  // paper records. Apply every veto before publishing the signal snapshot.
  const chosenHorizon = verdict.interval === '10 minute' ? 10 : 30;
  const executionForecast = verdict.forecasts && verdict.forecasts[chosenHorizon];
  const vetoExecution = (reason) => {
    if (executionForecast && executionForecast.action === 'TRADE') {
      executionForecast.action = 'WAIT';
      executionForecast.suppressed = reason;
    }
    verdict.suppressed = reason;
  };

  if (executionForecast && executionForecast.action === 'TRADE' && executionForecast.directie !== verdict.directie) {
    vetoExecution(`forecast ${chosenHorizon}m în dezacord cu direcția motorului`);
  }
  if (executionForecast && executionForecast.action === 'TRADE' &&
      config.sniperMode && !(verdict.sniper && verdict.sniper.eligible)) {
    vetoExecution(`setup Sniper neeligibil: ${verdict.sniper ? verdict.sniper.reason : 'fără confirmare'}`);
  }
  if (executionForecast && executionForecast.action === 'TRADE' &&
      (verdict.directie === 'NEUTRU' || CONF_RANK[verdict.incredere] < CONF_RANK[config.alertMinConfidence])) {
    vetoExecution(`încredere ${verdict.incredere} sub pragul ${config.alertMinConfidence}`);
  }
  if (executionForecast && executionForecast.action === 'TRADE' && !verdict.entryPriceFresh) {
    vetoExecution('preț de intrare 1m proaspăt indisponibil');
  }
  if (executionForecast && executionForecast.action === 'TRADE' &&
      config.useOrderFlow && config.requireOfAgree && verdict.ofAgree === 'conflict') {
    vetoExecution('order flow în conflict cu direcția');
  }
  if (executionForecast && executionForecast.action === 'TRADE' &&
      config.useLearning && verdict.learned && verdict.learned.ready &&
      verdict.learned.estimate != null && verdict.learned.estimate < config.learningSuppressBelow) {
    vetoExecution(`istoricul tău dă doar ${verdict.learned.estimate}% pe acest tipar`);
  }

  const forecastAllowsTrade = executionForecast &&
    executionForecast.action === 'TRADE' && executionForecast.directie === verdict.directie;
  if (!forecastAllowsTrade) {
    verdict.suppressed = verdict.suppressed || (executionForecast
      ? `forecast ${chosenHorizon}m: ${executionForecast.action}${executionForecast.suppressed ? ` (${executionForecast.suppressed})` : ''}`
      : `forecast ${chosenHorizon}m indisponibil`);
  }

  // One finalized execution snapshot drives the card/banner, signal SSE,
  // alert transition and journal record. Alert frequency is based exclusively
  // on this snapshot changing from WAIT to TRADE.
  verdict.execution = {
    horizon: chosenHorizon,
    action: forecastAllowsTrade ? 'TRADE' : 'WAIT',
    directie: executionForecast ? executionForecast.directie : 'NEUTRU',
    calibrated: !!(executionForecast && executionForecast.calibrated),
    calibrationVersion: executionForecast && executionForecast.calibrated ? 2 : null,
    calibrationSource: executionForecast && executionForecast.calibrated ? 'exact-horizon-forward' : null,
    probability: executionForecast && Number.isFinite(executionForecast.confidence) ? executionForecast.confidence : null,
    probabilityUp: executionForecast ? executionForecast.probabilityUp : null,
    probabilityDown: executionForecast ? executionForecast.probabilityDown : null,
    technicalConfidence: executionForecast ? executionForecast.technicalConfidence : null,
    setupValid: !!(executionForecast && executionForecast.setupValid),
    breakEven: executionForecast ? executionForecast.breakEven : null,
    expectedValue: executionForecast ? executionForecast.expectedValue : null,
    payoutPct: executionForecast ? executionForecast.payoutPct : null,
    reason: forecastAllowsTrade ? null : verdict.suppressed,
  };
  const previousExecution = prev && prev.execution;
  const shouldAlert = verdict.execution.action === 'TRADE' &&
    (!previousExecution || previousExecution.action !== 'TRADE');

  latest[symbol] = verdict;
  broadcast('signal', verdict);

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
      action: verdict.execution.action,
      horizon: verdict.execution.horizon,
      probability: verdict.execution.probability,
      probabilityUp: verdict.execution.probabilityUp,
      probabilityDown: verdict.execution.probabilityDown,
      calibrated: verdict.execution.calibrated,
      calibrationVersion: verdict.execution.calibrationVersion,
      calibrationSource: verdict.execution.calibrationSource,
      technicalConfidence: verdict.execution.technicalConfidence,
      setupValid: verdict.execution.setupValid,
      breakEven: verdict.execution.breakEven,
      expectedValue: verdict.execution.expectedValue,
      payoutPct: verdict.execution.payoutPct,
      ts: verdict.ts,
    };
    alerts.unshift(alert);
    if (alerts.length > 50) alerts.pop();
    // Auto-journal every alert with rich context for the learning layer.
    const logged = journal.record({
      ...alert,
      setup: verdict.setup,
      hourUTC,
      stake: config.paperStake,
      payoutPct: alert.interval === '10 minute' ? config.payout10 : config.payout30,
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
    const resolved = await journal.resolvePending((sym, resolveTs) => mexc.fetchSettlementPrice(sym, resolveTs));
    if (resolved.length) {
      broadcast('journal', { stats: journal.stats(), recent: journal.recent(40), learning: learning.summary(journal.all()) });
      for (const r of resolved) {
        if (r.status === 'void') {
          console.log(`[VOID] ${r.symbol} ${r.directie}: settlement exact indisponibil după perioada de grație`);
        } else {
          console.log(`[RESOLVED] ${r.symbol} ${r.directie} ${r.entryPrice}->${r.exitPrice} => ${r.win ? 'WIN' : 'LOSS'}`);
        }
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
  if (body.paperStake != null) {
    const v = Number(body.paperStake);
    if (Number.isFinite(v) && v > 0 && v <= 100000) config.paperStake = v;
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
  const server = app.listen(port, '127.0.0.1', () => {
    console.log('====================================================');
    console.log('  SignalPilot — MEXC live UP/DOWN engine');
    console.log('====================================================');
    console.log(`  Running at http://localhost:${port}`);
    console.log(`  AI (Gemini): ${config.gemini.enabled && config.gemini.apiKey ? 'ENABLED' : 'disabled'}`);
    console.log(`  Symbols: ${config.symbols.join(', ')}`);
    console.log('  (Se deschide singur in browser. Ca sa opresti: inchide fereastra.)');
    console.log('====================================================');
    startScheduler();
    startResolver();
    if (process.env.NO_OPEN !== '1') openBrowser(`http://localhost:${port}`);
    // Reachability is informational and must never delay the UI opening.
    mexc.ping()
      .then((ok) => console.log(ok ? '  MEXC reachable: OK' : '  WARNING: MEXC not reachable from this machine.'))
      .catch(() => console.log('  WARNING: MEXC not reachable from this machine.'));
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
