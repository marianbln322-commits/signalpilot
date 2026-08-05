'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const market = require('./lib/mexc-market-data');
const expertEngine = require('./lib/expert-engine');
const { buildChartData } = require('./lib/chart-state');
const { Journal, atomicWriteJson } = require('./lib/journal');
const { chooseEstimate } = require('./lib/calibration');

const HOST = '127.0.0.1';
const PORT = 3009;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKTEST_WORKER = path.join(__dirname, 'lib', 'backtest-worker.js');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const DEFAULT_CONFIG = Object.freeze({
  symbols: ['BTCUSDT', 'ETHUSDT'], scanIntervalSec: 15, settleDelayMs: 1_500,
  minQuality10: 65, minQuality30: 68, payout10: 0.8, payout30: 0.8,
});

function finiteInRange(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return number;
}

function validateConfig(input) {
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  for (const key of Object.keys(input || {})) if (!allowed.has(key)) throw new Error(`unsupported config field: ${key}`);
  if (!Array.isArray(input.symbols) || !input.symbols.length || input.symbols.length > 10) throw new Error('symbols must contain 1-10 values');
  const symbols = [...new Set(input.symbols.map((symbol) => String(symbol).trim().toUpperCase()))];
  if (symbols.some((symbol) => !/^[A-Z0-9]{5,20}$/.test(symbol))) throw new Error('symbols must use MEXC spot format, e.g. BTCUSDT');
  return {
    symbols,
    scanIntervalSec: Math.round(finiteInRange(input.scanIntervalSec, 'scanIntervalSec', 5, 300)),
    settleDelayMs: Math.round(finiteInRange(input.settleDelayMs, 'settleDelayMs', 0, 30_000)),
    minQuality10: Math.round(finiteInRange(input.minQuality10, 'minQuality10', 0, 100)),
    minQuality30: Math.round(finiteInRange(input.minQuality30, 'minQuality30', 0, 100)),
    payout10: finiteInRange(input.payout10, 'payout10', 0.01, 5),
    payout30: finiteInRange(input.payout30, 'payout30', 0.01, 5),
  };
}

function loadConfig() {
  try {
    return validateConfig({ ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[config] using defaults: ${error.message}`);
    return { ...DEFAULT_CONFIG, symbols: [...DEFAULT_CONFIG.symbols] };
  }
}

let config = loadConfig();
const journal = new Journal(JOURNAL_FILE);
const state = {
  startedAt: Date.now(), scanning: false, lastScanStartedAt: null, lastScanCompletedAt: null,
  scanClock: null, latest: {}, errors: {}, alerts: [], backtests: {}, backtestProgress: null,
};
const clients = new Set();
let stopped = false;
let schedulerTimer = null;
let scanPromise = null;
let activeBacktest = null;
let shuttingDown = false;
let configRevision = 0;
let rescanRequested = false;

function probabilityEstimate(symbol, prediction, journalState) {
  const forward = journalState.calibration && journalState.calibration.bySymbol
    ? journalState.calibration.bySymbol[symbol] : null;
  const backtestResult = state.backtests[symbol];
  const backtest = backtestResult && backtestResult.calibration;
  const estimate = chooseEstimate({
    verdict: prediction.direction || prediction.verdict,
    horizonMin: prediction.horizonMin,
    quality: prediction.quality,
    forward,
    backtest,
  });
  if (estimate.status === 'estimated') {
    return {
      status: 'estimated', source: estimate.source, bucketKey: estimate.bucket.key,
      winRate: estimate.bucket.winRate, n: estimate.bucket.n, wilson95: estimate.bucket.wilson95,
      disclosure: estimate.source === 'forward'
        ? 'Frecvență istorică forward pentru semnale comparabile; nu prezice sigur semnalul curent.'
        : 'Binance proxy/in-sample, nu istoric MEXC exact; nu prezice sigur semnalul curent.',
    };
  }
  if (estimate.status === 'insufficient') {
    return {
      status: 'insufficient', bucketKey: estimate.key, n: estimate.n,
      forwardN: estimate.forwardN, backtestN: estimate.backtestN,
      reason: 'Eșantion insuficient pentru un procent onest.',
    };
  }
  return { status: 'not-estimated', reason: 'WAIT nu primește probabilitate.' };
}

function publicState() {
  const journalState = journal.snapshot();
  const latest = Object.fromEntries(Object.entries(state.latest).map(([symbol, result]) => [symbol, {
    ...result,
    predictions: Object.fromEntries(Object.entries(result.predictions).map(([horizon, prediction]) => [horizon, {
      ...prediction,
      probabilityEstimate: probabilityEstimate(symbol, prediction, journalState),
    }])),
  }]));
  return {
    app: 'SignalPilot Expert', endpoint: `http://${HOST}:${PORT}`, aliases: [...ALLOWED_ORIGINS], config,
    status: {
      startedAt: state.startedAt, scanning: state.scanning,
      lastScanStartedAt: state.lastScanStartedAt, lastScanCompletedAt: state.lastScanCompletedAt,
      scanClock: state.scanClock, errors: state.errors, backtestProgress: state.backtestProgress,
    },
    latest, alerts: state.alerts, journal: journalState, backtests: state.backtests,
    warning: 'Estimarea istorică este afișată numai pentru bucket-ul horizon+direction+quality cu eșantion suficient. Binance este proxy/in-sample; niciun procent nu prezice sigur semnalul curent. Nu există promisiune de precizie sau profit.',
  };
}

function removeClient(client) {
  clearInterval(client.heartbeat);
  clients.delete(client);
  try { client.response.end(); } catch { /* already closed */ }
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...clients]) {
    try {
      if (client.response.destroyed || client.response.writableEnded) removeClient(client);
      else client.response.write(message);
    } catch {
      removeClient(client);
    }
  }
}

function pruneUnconfiguredState() {
  for (const symbol of Object.keys(state.latest)) if (!config.symbols.includes(symbol)) delete state.latest[symbol];
  for (const symbol of Object.keys(state.errors)) if (!config.symbols.includes(symbol)) delete state.errors[symbol];
}

function publishSnapshot(symbol, rawSnapshot, clock, generatedAt, analysisConfig) {
  const snapshot = market.revalidateSnapshot(rawSnapshot, generatedAt);
  snapshot.clockSource = clock.source;
  const result = expertEngine.analyzeSnapshot(snapshot, analysisConfig);
  result.chartData = buildChartData(snapshot, result);
  result.clockSource = clock.source;
  result.clockFallback = clock.fallback;
  result.clockSkewMs = clock.localSkewMs;
  result.stale = false;
  state.latest[symbol] = result;
  delete state.errors[symbol];
  return result;
}

async function scanOnce() {
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    const scanRevision = configRevision;
    const scanConfig = { ...config, symbols: [...config.symbols] };
    state.scanning = true;
    state.lastScanStartedAt = Date.now();
    const clock = await market.getScanClock({ timeoutMs: 5_000 });
    state.scanClock = clock;
    if (scanRevision !== configRevision) {
      pruneUnconfiguredState();
      state.lastScanCompletedAt = Date.now();
      state.scanClock = { ...clock, discarded: true, discardReason: 'CONFIG_CHANGED_DURING_SCAN' };
      state.scanning = false;
      broadcast('scan-complete', { ...publicState(), newAlerts: [] });
      return;
    }
    if (clock.fallback) {
      const completedAt = Date.now();
      for (const symbol of scanConfig.symbols) {
        state.errors[symbol] = {
          at: completedAt,
          message: `CLOCK_UNVERIFIED_FAIL_CLOSED: ${clock.warning || 'MEXC server time unavailable'}`,
          staleResultRemoved: true,
        };
        delete state.latest[symbol];
      }
      state.lastScanCompletedAt = completedAt;
      state.scanClock = { ...clock, failClosed: true, completedAtLocal: completedAt };
      state.scanning = false;
      broadcast('scan-complete', { ...publicState(), newAlerts: [] });
      return;
    }
    const snapshots = {};
    const oneMinuteBySymbol = {};

    for (const symbol of scanConfig.symbols) {
      if (stopped || scanRevision !== configRevision) break;
      try {
        const snapshot = await market.fetchSymbolSnapshot(symbol, {
          asOf: market.correctedNow(clock), settleDelayMs: scanConfig.settleDelayMs,
          limit: market.REQUEST_CANDLE_COUNT, timeoutMs: 9_000,
        });
        snapshots[symbol] = snapshot;
        oneMinuteBySymbol[symbol] = snapshot.candles['1m'];
      } catch (error) {
        state.errors[symbol] = { at: Date.now(), message: error.message, staleResultRemoved: true };
        delete state.latest[symbol];
      }
    }

    if (scanRevision !== configRevision) {
      pruneUnconfiguredState();
      state.lastScanCompletedAt = Date.now();
      state.scanClock = { ...clock, discarded: true, discardReason: 'CONFIG_CHANGED_DURING_SCAN' };
      state.scanning = false;
      broadcast('scan-complete', { ...publicState(), newAlerts: [] });
      return;
    }

    // All symbols are published in one batch. This clock is captured after network acquisition,
    // so freshness gates and contract entry boundaries reflect when the scan can actually be shown.
    const generatedAt = market.correctedNow(clock);
    const alerts = [];
    for (const [symbol, snapshot] of Object.entries(snapshots)) {
      try {
        const result = publishSnapshot(symbol, snapshot, clock, generatedAt, scanConfig);
        for (const prediction of Object.values(result.predictions)) {
          const entry = journal.record(prediction);
          if (!entry) continue;
          const alert = {
            signalKey: prediction.signalKey, symbol, horizonMin: prediction.horizonMin,
            action: prediction.action, direction: prediction.direction, verdict: prediction.verdict,
            quality: prediction.quality, trigger: prediction.trigger,
            generatedAt: prediction.generatedAt,
          };
          state.alerts.unshift(alert);
          alerts.push(alert);
        }
      } catch (error) {
        state.errors[symbol] = { at: Date.now(), message: error.message, staleResultRemoved: true };
        delete state.latest[symbol];
      }
    }
    state.alerts.length = Math.min(state.alerts.length, 100);

    journal.resolveFromClosedCandles(oneMinuteBySymbol);
    state.lastScanCompletedAt = Date.now();
    state.scanClock = {
      ...clock,
      publishedAtCorrected: generatedAt,
      completedAtLocal: state.lastScanCompletedAt,
    };
    state.scanning = false;
    broadcast('scan-complete', { ...publicState(), newAlerts: alerts });
  })().finally(() => {
    state.scanning = false;
    scanPromise = null;
  });
  return scanPromise;
}

function scheduleNext(delayMs = 0) {
  clearTimeout(schedulerTimer);
  schedulerTimer = setTimeout(async () => {
    try {
      await scanOnce();
    } catch (error) {
      console.error(`[scan] ${error.stack || error.message}`);
      state.scanning = false;
    } finally {
      if (!stopped) {
        const delay = rescanRequested ? 0 : config.scanIntervalSec * 1_000;
        rescanRequested = false;
        scheduleNext(delay);
      }
    }
  }, delayMs);
}

function startBacktest(workerData, key, symbol) {
  const worker = new Worker(BACKTEST_WORKER, { workerData });
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.type === 'progress') {
        state.backtestProgress = { symbol, ...message.progress };
        broadcast('backtest-progress', state.backtestProgress);
      } else if (message.type === 'result') {
        settled = true;
        state.backtests[symbol] = message.result;
        state.backtestProgress = null;
        resolve(message.result);
      } else if (message.type === 'error') {
        settled = true;
        state.backtestProgress = null;
        reject(new Error(message.error && message.error.message ? message.error.message : 'backtest worker failed'));
      }
    });
    worker.once('error', (error) => {
      if (!settled) reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`backtest worker exited with code ${code}`));
    });
  });
  activeBacktest = { key, symbol, worker, promise };
  promise.finally(() => {
    if (activeBacktest && activeBacktest.promise === promise) activeBacktest = null;
  }).catch(() => {});
  return activeBacktest;
}

const app = express();
app.disable('x-powered-by');
app.use((request, response, next) => {
  response.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  });
  const hostAllowed = ALLOWED_HOSTS.has(String(request.headers.host || '').toLowerCase());
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const originAllowed = isMutation
    ? ALLOWED_ORIGINS.has(request.headers.origin)
    : !request.headers.origin || ALLOWED_ORIGINS.has(request.headers.origin);
  if (!hostAllowed || !originAllowed) {
    response.status(403).json({ error: 'SignalPilot Expert accepts only same-origin loopback requests on 127.0.0.1:3009 or localhost:3009' });
    return;
  }
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));

app.get('/api/state', (_request, response) => response.json(publicState()));

app.get('/api/stream', (request, response) => {
  response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  response.flushHeaders();
  const client = { response, heartbeat: null };
  client.heartbeat = setInterval(() => {
    try { response.write(': keepalive\n\n'); } catch { removeClient(client); }
  }, 15_000);
  clients.add(client);
  response.write(`event: snapshot\ndata: ${JSON.stringify(publicState())}\n\n`);
  request.on('close', () => removeClient(client));
});

app.post('/api/config', (request, response) => {
  try {
    const next = validateConfig(request.body || {});
    atomicWriteJson(CONFIG_FILE, next);
    config = next;
    configRevision += 1;
    pruneUnconfiguredState();
    if (scanPromise) rescanRequested = true;
    else scheduleNext(0);
    broadcast('config', config);
    response.json({ ok: true, config });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post('/api/backtest', async (request, response) => {
  try {
    const symbol = String(request.body && request.body.symbol || '').trim().toUpperCase();
    if (!config.symbols.includes(symbol)) throw new Error('symbol must be one of configured symbols');
    const days = Math.min(30, Math.max(1, Math.floor(Number(request.body && request.body.days) || 7)));
    const workerData = {
      symbol, days, minQuality10: config.minQuality10, minQuality30: config.minQuality30,
      payout10: config.payout10, payout30: config.payout30, cacheDir: CACHE_DIR,
    };
    const key = JSON.stringify(workerData);
    if (activeBacktest && activeBacktest.key !== key) {
      response.status(429).json({ error: 'another backtest is already running; retry after it completes' });
      return;
    }
    if (!activeBacktest) startBacktest(workerData, key, symbol);
    response.json(await activeBacktest.promise);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.use((error, _request, response, _next) => response.status(error.type === 'entity.parse.failed' ? 400 : 500).json({ error: error.message }));

const server = app.listen(PORT, HOST);
server.once('listening', () => {
  console.log(`SignalPilot Expert listening only on http://${HOST}:${PORT} (localhost alias accepted)`);
  scheduleNext(0);
});
server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`SignalPilot Expert cannot start: ${HOST}:${PORT} is already occupied. No fallback port is used.`);
  else console.error(`SignalPilot Expert cannot start: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopped = true;
  clearTimeout(schedulerTimer);
  for (const client of [...clients]) removeClient(client);
  const tasks = [];
  if (activeBacktest && activeBacktest.worker) tasks.push(activeBacktest.worker.terminate().catch(() => {}));
  tasks.push(new Promise((resolve) => server.close(resolve)));
  const timeout = new Promise((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([Promise.allSettled(tasks), timeout]);
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

module.exports = { app, server, scanOnce, validateConfig, publicState, probabilityEstimate, buildChartData, shutdown };
