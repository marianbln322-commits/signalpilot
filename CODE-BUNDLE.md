# SignalPilot — pachet complet de cod pentru analiză

Aplicație locală Node.js care citește date live de pe MEXC, calculează indicatori tehnici + Smart Money Concepts + order flow, și produce decizii UP/DOWN pe 10/30 min pentru contracte event-futures.

**Generat automat de `tools/bundle.js`.** Nu edita acest fișier direct — regenerează-l.

**Pentru cine analizează codul:** partea esențială nu e lista de indicatori, ci lanțul de decizie:

1. `lib/candles.js` — taie lumânarea în formare, ca verdictele să nu se schimbe în timpul barei (*repainting*).
2. `lib/smc.js` — Smart Money Concepts; FVG-urile cer *displacement* raportat la ATR și sunt acționabile doar la primul retest.
3. `lib/engine.js` — confluență ponderată → direcție + fereastra (10/30 min) dată de declanșatorul principal.
4. `lib/calibration.js` — scorul de confluență **nu** e o probabilitate; aici se măsoară empiric ce valorează fiecare bucket și se compară limita inferioară Wilson cu pragul `1/(1+payout)`.
5. `lib/backtest.js` — evaluare out-of-sample, cu baseline și test de semnificație.

Verificare offline, fără rețea și fără chei: `node tools/selftest.js`

Structura:
```
./package.json
./config.example.json
./server.js
./lib/candles.js
./lib/priceTape.js
./lib/sizing.js
./lib/mexc.js
./lib/binance.js
./lib/indicators.js
./lib/smc.js
./lib/engine.js
./lib/calibration.js
./lib/orderflow.js
./lib/learning.js
./lib/journal.js
./lib/gemini.js
./lib/backtest.js
./tools/selftest.js
./tools/doctor.js
./public/index.html
./public/app.js
./public/style.css
./README.md
```


## `package.json`

```json
{
  "name": "signalpilot",
  "version": "1.0.0",
  "description": "Local real-time MEXC signal engine for 10/30-min event-futures UP/DOWN decisions (deterministic indicators + SMC, optional Gemini narrator, backtest).",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "doctor": "node tools/doctor.js",
    "selftest": "node tools/selftest.js",
    "bundle": "node tools/bundle.js"
  },
  "author": "",
  "license": "MIT",
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
```


## `config.example.json`

```json
{
  "symbols": ["BTCUSDT", "ETHUSDT"],
  "scanIntervalSec": 8,
  "alertMinConfidence": "Mediu",
  "sniperMode": true,
  "sniperRequireVolume": false,
  "activeHoursUTC": [6, 7, 8, 9, 13, 14, 15, 16, 17],
  "adaptiveInterval": false,
  "payout10": 65,
  "payout30": 82,
  "requireEvGate": true,
  "evMarginPct": 1.5,
  "calibrationMinSample": 30,
  "bankroll": 1000,
  "kellyFractionMultiplier": 0.25,
  "maxStakePct": 5,
  "minStakePct": 0.5,
  "maxEntryDelaySec": 90,
  "settlementTwapSec": 30,
  "priceSampleSec": 3,
  "useOrderFlow": true,
  "requireOfAgree": false,
  "useLearning": true,
  "learningSuppressBelow": 45,
  "gemini": {
    "enabled": false,
    "apiKey": "",
    "model": "gemini-3.5-flash"
  }
}
```


## `server.js`

```javascript
'use strict';

// ============================================================================
// SignalPilot server — always-on local app (PinPilot style).
// Serves the UI at http://localhost:3011, polls MEXC, runs the engine on a
// scheduler, pushes live updates over SSE, and alerts on good setups.
// ============================================================================

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
// Fail with a readable message instead of a cryptic "fetch is not defined" crash
// deep inside a request. The exchange clients rely on the global fetch API, which
// only exists from Node 18 onwards.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`\n  Ai Node.js v${process.versions.node}, dar aplicația are nevoie de v18 sau mai nou.`);
  console.error('  Descarcă versiunea LTS de pe https://nodejs.org apoi pornește din nou.\n');
  process.exit(1);
}

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
const sizing = require('./lib/sizing');
const { PriceTape } = require('./lib/priceTape');

// Port 3011 by default so it runs alongside PinPilot (3004) and older
// SignalPilot versions (3001/3002/3005). Override with the PORT env var if needed.
const PORT = process.env.PORT || 3011;
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

  // Observation mode. Before any calibration exists, the EV gate blocks every
  // alert — correct, but it makes the app look dead and indistinguishable from
  // broken. With this on, uncalibrated signals are still surfaced, explicitly
  // labelled as OBSERVATION rather than as a recommendation, so the engine's work
  // is visible while the journal fills up. It never invents a probability.
  observationMode: true,

  // Position sizing. Stakes are derived from the measured edge via fractional
  // Kelly on the CONSERVATIVE probability, then hard-capped. See lib/sizing.js.
  bankroll: 1000,
  kellyFractionMultiplier: 0.25,
  maxStakePct: 5,
  minStakePct: 0.5,

  // Entry window. A verdict is computed at bar close; entering several minutes
  // later is a materially different trade (shorter effective horizon, different
  // entry price), so a stale signal is not actionable.
  maxEntryDelaySec: 90,

  // Settlement. MEXC determines Up/Down settlement from a composite index with a
  // time-weighted average, so outcomes are graded on a TWAP over the final
  // seconds rather than a single tick.
  settlementTwapSec: 30,
  priceSampleSec: 3,
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
// Rolling price tape, sampled independently of the scan loop, so settlement can
// use a time-weighted average over the final seconds of a contract window.
const tape = new PriceTape();

// Rolling diagnostics. An app that shows nothing is indistinguishable from an app
// that is broken, so it has to be able to explain its own silence: what it saw,
// and which filter stopped it.
const diag = {
  startedAt: Date.now(),
  scans: 0,
  fetchErrors: 0,
  lastFetchError: null,
  lastScanAt: null,
  verdicts: { UP: 0, DOWN: 0, NEUTRU: 0 },
  suppressions: {},   // reason -> count
  alertsFired: 0,
  observations: 0,
  recentBars: [],     // last 40 bar-level outcomes, for the UI timeline
};

function noteSuppression(reason) {
  // Collapse to a short key so the counter stays readable.
  const key = String(reason || 'necunoscut').split(':')[0].slice(0, 70);
  diag.suppressions[key] = (diag.suppressions[key] || 0) + 1;
}

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

    // ---- Position sizing --------------------------------------------------
    // Bigger edge -> bigger stake, but derived from the conservative probability
    // and shrunk by how many outcomes it rests on. See lib/sizing.js for why the
    // cap matters: a binary contract has no partial exit.
    verdict.sizing = sizing.recommend(verdict.gate, payoutFor(verdict.interval), {
      bankroll: config.bankroll,
      kellyFractionMultiplier: config.kellyFractionMultiplier,
      maxStakePct: config.maxStakePct,
      minStakePct: config.minStakePct,
    });

    // ---- Entry window -----------------------------------------------------
    // The verdict describes the bar that just closed. Acting on it 6 minutes
    // later is a different trade: the effective horizon is shorter and the entry
    // price has moved. Signals therefore expire.
    const closeTs = verdict.barCloseTime || verdict.ts;
    const deadlineTs = closeTs + config.maxEntryDelaySec * 1000;
    const secondsLeft = Math.round((deadlineTs - Date.now()) / 1000);
    verdict.entryWindow = {
      barCloseTime: closeTs,
      deadlineTs,
      secondsLeft,
      stale: secondsLeft <= 0,
      maxEntryDelaySec: config.maxEntryDelaySec,
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
      const uncalibrated = verdict.gate && verdict.gate.needsData;
      if (uncalibrated && config.observationMode) {
        // Surface it, but never as a recommendation. The distinction is carried
        // through to the UI and the alert feed.
        verdict.observation = true;
        verdict.observationNote = 'necalibrat — semnal afișat pentru observare, NU e recomandare de intrare';
      } else {
        shouldAlert = false;
        verdict.suppressed = uncalibrated
          ? `fără probabilitate calibrată: ${verdict.gate.reason}`
          : `EV nefavorabil: ${verdict.gate ? verdict.gate.reason : 'necunoscut'}`;
      }
    }
  }

  // Staleness veto: never alert on a bar whose entry window has already passed
  // (e.g. after the app was asleep, or a slow poll).
  if (shouldAlert && verdict.entryWindow && verdict.entryWindow.stale) {
    shouldAlert = false;
    verdict.suppressed = `semnal expirat (bara s-a închis acum ${Math.round((Date.now() - verdict.entryWindow.barCloseTime) / 1000)}s, limita e ${config.maxEntryDelaySec}s)`;
  }

  // Sizing veto: if the measured edge is too small to justify a minimum stake,
  // there is nothing to trade even though the direction may be right. Skipped in
  // observation mode, where by definition there is no stake to compute.
  if (shouldAlert && !verdict.observation && verdict.sizing && verdict.sizing.stake <= 0) {
    shouldAlert = false;
    verdict.suppressed = verdict.sizing.reason;
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

  // Record what happened on this bar, once per bar, for the diagnostics panel.
  if (barKey != null && !alreadyActed) {
    diag.verdicts[verdict.directie] = (diag.verdicts[verdict.directie] || 0) + 1;
    if (verdict.suppressed) noteSuppression(verdict.suppressed);
    else if (verdict.directie === 'NEUTRU') noteSuppression('motorul e NEUTRU (niciun declanșator valid)');
    diag.recentBars.unshift({
      symbol,
      barCloseTime: verdict.barCloseTime,
      directie: verdict.directie,
      setup: verdict.setup,
      interval: verdict.interval,
      score: verdict.score,
      alerted: shouldAlert,
      observation: !!verdict.observation,
      blocked: verdict.suppressed || null,
    });
    if (diag.recentBars.length > 40) diag.recentBars.pop();
  }

  if (shouldAlert) {
    if (barKey != null) lastActedBar[symbol] = barKey;
    if (verdict.observation) diag.observations++; else diag.alertsFired++;
    const alert = {
      symbol,
      directie: verdict.directie,
      interval: verdict.interval,
      incredere: verdict.incredere,
      setup: verdict.setup,
      probability: verdict.prediction ? verdict.prediction.probability : null,
      ev: verdict.gate ? verdict.gate.ev : null,
      stake: verdict.sizing ? verdict.sizing.stake : null,
      stakePct: verdict.sizing ? verdict.sizing.pctOfBankroll : null,
      tier: verdict.sizing ? verdict.sizing.tier : null,
      tierLabel: verdict.sizing ? verdict.sizing.tierLabel : null,
      deadlineTs: verdict.entryWindow ? verdict.entryWindow.deadlineTs : null,
      price: verdict.price,
      justificare: verdict.justificare,
      sniper: !!(verdict.sniper && verdict.sniper.eligible),
      observation: !!verdict.observation,
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
    console.log(`[ALERT${alert.sniper ? ' 🎯' : ''}] ${symbol} ${verdict.directie} ${verdict.interval} · p=${alert.probability != null ? alert.probability + '%' : 'n/a'} EV=${alert.ev != null ? alert.ev + '%' : '?'} · miză ${alert.tierLabel} ${alert.stake} (${alert.stakePct}%) @ ${verdict.price}`);
  }
  return verdict;
}

// Settlement price for one entry: a time-weighted average over the final
// `settlementTwapSec` before expiry, matching how MEXC states Up/Down contracts
// are settled (composite index + TWAP). Falls back to a live tick only if the
// tape has no samples in the window, and records which method was used so the
// journal never silently mixes the two.
async function settlePrice(symbol, resolveTs) {
  const windowMs = config.settlementTwapSec * 1000;
  const t = tape.twap(symbol, resolveTs - windowMs, resolveTs);
  if (t && Number.isFinite(t.price)) return t;
  try {
    const p = await mexc.fetchPrice(symbol);
    return { price: p, method: 'last-price-fallback', samples: 1 };
  } catch {
    return null;
  }
}

// Independent price sampler feeding the tape. Kept separate from the scan loop
// so settlement resolution does not depend on scan cadence or on scans succeeding.
async function samplePrices() {
  await Promise.all(config.symbols.map(async (sym) => {
    try {
      const p = await mexc.fetchPrice(sym);
      tape.push(sym, p);
    } catch { /* transient; next tick */ }
  }));
}

// Background resolver: closes out pending journal entries automatically.
async function resolveJournal() {
  try {
    const resolved = await journal.resolvePending(settlePrice);
    if (resolved.length) {
      broadcast('journal', { stats: journal.stats(), recent: journal.recent(40), learning: learning.summary(journal.all()) });
      for (const r of resolved) {
        const m = r.settlement ? `${r.settlement.method}/${r.settlement.samples}` : '?';
        console.log(`[RESOLVED] ${r.symbol} ${r.directie} ${r.entryPrice} -> ${Number(r.exitPrice).toFixed(4)} (${m}) => ${r.win ? 'WIN' : 'LOSS'}`);
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
        diag.scans++;
        diag.lastScanAt = Date.now();
      } catch (e) {
        diag.fetchErrors++;
        diag.lastFetchError = { symbol, message: e.message, at: Date.now() };
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
  resolveTimer = setInterval(resolveJournal, 5000);
}

// Price sampler: fast and cheap, feeds the TWAP tape used for settlement.
let sampleTimer = null;
function startSampler() {
  if (sampleTimer) clearInterval(sampleTimer);
  const ms = Math.max(1, config.priceSampleSec) * 1000;
  sampleTimer = setInterval(samplePrices, ms);
  samplePrices();
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
    calibration: calModel ? { total: calModel.total, fittedAt: calModel.fittedAt, minSample: calModel.minSample } : null,
    // Settlement readiness: without price samples, outcomes fall back to a single
    // tick, which is not how the contract settles. Surfaced so it is visible.
    settlement: {
      twapSec: config.settlementTwapSec,
      tape: Object.fromEntries(config.symbols.map((s) => [s, tape.stats(s)])),
    },
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
  if (typeof body.observationMode === 'boolean') config.observationMode = body.observationMode;
  if (body.evMarginPct != null) {
    const v = Number(body.evMarginPct);
    if (v >= 0 && v <= 15) config.evMarginPct = v;
  }
  if (body.calibrationMinSample != null) {
    const v = Number(body.calibrationMinSample);
    if (v >= 10 && v <= 500) config.calibrationMinSample = v;
  }
  if (body.bankroll != null) {
    const v = Number(body.bankroll);
    if (v > 0 && v <= 1e9) config.bankroll = v;
  }
  if (body.kellyFractionMultiplier != null) {
    const v = Number(body.kellyFractionMultiplier);
    // Above full Kelly is never a defensible setting, so it is not accepted.
    if (v > 0 && v <= 1) config.kellyFractionMultiplier = v;
  }
  if (body.maxStakePct != null) {
    const v = Number(body.maxStakePct);
    if (v > 0 && v <= 25) config.maxStakePct = v;
  }
  if (body.maxEntryDelaySec != null) {
    const v = Number(body.maxEntryDelaySec);
    if (v >= 10 && v <= 600) config.maxEntryDelaySec = v;
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
  startSampler(); // symbols or cadence may have changed
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

// Self-explanation endpoint: "why am I not seeing signals?"
app.get('/api/diagnose', (req, res) => {
  const resolved = journal.all().filter((e) => e.status === 'resolved').length;
  const pending = journal.all().filter((e) => e.status === 'pending').length;
  const needed = config.calibrationMinSample || 30;

  // The single most useful line: what is the actual blocker right now.
  let headline;
  let action = null;
  if (diag.fetchErrors > 0 && diag.scans === 0) {
    headline = 'Nu pot ajunge la MEXC — fără date nu există semnale.';
    action = 'Verifică https://api.mexc.com/api/v3/ping în browser. Dacă nici acolo nu răspunde, e blocat de rețeaua ta.';
  } else if (!calModel && resolved < needed) {
    headline = `Nu există încă o probabilitate măsurată (${resolved}/${needed} rezultate în jurnal).`;
    action = 'Apasă "Calibrează pe ultimele 30 de zile" ca să obții probabilități imediat, din istoric.';
  } else {
    headline = 'Sistemul are date și calibrare. Semnalele apar când un setup trece pragul.';
  }

  res.json({
    headline,
    action,
    uptimeSec: Math.round((Date.now() - diag.startedAt) / 1000),
    scans: diag.scans,
    lastScanAt: diag.lastScanAt,
    fetchErrors: diag.fetchErrors,
    lastFetchError: diag.lastFetchError,
    verdicts: diag.verdicts,
    alertsFired: diag.alertsFired,
    observations: diag.observations,
    blockedBy: Object.entries(diag.suppressions)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count })),
    recentBars: diag.recentBars,
    calibration: calModel
      ? { total: calModel.total, minSample: calModel.minSample, fittedAt: calModel.fittedAt }
      : null,
    journal: { resolved, pending, needed },
    observationMode: config.observationMode,
    requireEvGate: config.requireEvGate,
    sniperMode: config.sniperMode,
    settlementTape: Object.fromEntries(config.symbols.map((s) => [s, tape.stats(s)])),
  });
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
    startSampler();
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


## `lib/candles.js`

```javascript
'use strict';

// ============================================================================
// candles.js — candle hygiene. This module exists to kill ONE specific class of
// bug: acting on the candle that is still forming.
//
// WHY THIS MATTERS
// MEXC/Binance kline endpoints return the in-progress candle as the last row.
// Its high/low/close/volume keep changing until the bar closes. Any detector
// that reads that row (sweeps, volume spikes, wick ratios, RSI, MACD...) will
// produce a verdict that mutates during the bar — the classic "repainting"
// problem. The live app then flips UP/DOWN mid-bar, while the backtest — which
// replays only completed bars — never sees those flips. Backtest and live stop
// describing the same strategy, so the measured win-rate is meaningless.
//
// The rule enforced here: decisions are computed ONLY from confirmed, closed
// candles. The forming candle is still useful for displaying the current price,
// but it never feeds a detector.
// ============================================================================

// Is this candle definitively closed?
// A candle is closed once wall-clock time has passed its closeTime.
function isClosed(candle, now = Date.now()) {
  if (!candle) return false;
  if (Number.isFinite(candle.closeTime) && candle.closeTime > 0) return now > candle.closeTime;
  return false; // unknown closeTime -> treat as unconfirmed (fail safe)
}

// Drop any trailing candles that have not closed yet.
// Returns a NEW array; never mutates the input.
function closedOnly(candles, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  let end = candles.length;
  while (end > 0 && !isClosed(candles[end - 1], now)) end--;
  return candles.slice(0, end);
}

// Split a series into { closed, forming }.
// `forming` is the in-progress candle (or null) — display only.
function split(candles, now = Date.now()) {
  const closed = closedOnly(candles, now);
  const forming = closed.length < candles.length ? candles[candles.length - 1] : null;
  return { closed, forming };
}

// Aggregate k consecutive candles into one higher-timeframe candle.
// Only emits COMPLETE groups, so the tail is never a partial bar.
// Used to derive 15m/60m views from a 5m series with guaranteed alignment.
function aggregate(candles, k) {
  const out = [];
  if (!Array.isArray(candles) || k < 1) return out;
  for (let i = 0; i + k <= candles.length; i += k) {
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (let j = i; j < i + k; j++) {
      if (candles[j].high > high) high = candles[j].high;
      if (candles[j].low < low) low = candles[j].low;
      volume += candles[j].volume;
    }
    out.push({
      openTime: candles[i].openTime,
      open: candles[i].open,
      high,
      low,
      close: candles[i + k - 1].close,
      volume,
      closeTime: candles[i + k - 1].closeTime,
    });
  }
  return out;
}

// Keep only candles that had already closed at or before `asOf`.
// This is the core no-look-ahead primitive for the backtest: it reconstructs
// exactly the information set available at decision time.
function upTo(candles, asOf) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((c) => c.closeTime <= asOf);
}

module.exports = { isClosed, closedOnly, split, aggregate, upTo };
```


## `lib/priceTape.js`

```javascript
'use strict';

// ============================================================================
// priceTape.js — a short rolling tape of observed prices per symbol, so outcomes
// can be settled on a TIME-WEIGHTED AVERAGE rather than one instantaneous tick.
//
// WHY THIS MATTERS MORE THAN IT LOOKS
// MEXC states that Up/Down prediction settlement prices are determined from a
// composite real-time index combined with a time-weighted average price:
// https://blog.mexc.com/press-release/mexc-launches-up-or-down-prediction-feature/
//
// The journal previously graded every signal by calling /ticker/price once at
// expiry and comparing that single tick to the entry price. So the app was
// scoring itself on a different scoreboard from the one that pays out. The gap
// is not cosmetic:
//
//   - A wick in the final seconds flips a single-tick comparison but barely
//     moves a TWAP, so "wins" were being recorded that the contract would have
//     settled as losses (and the reverse).
//   - TWAP systematically damps end-of-window spikes, which is exactly where
//     10-minute predictions are decided.
//
// Averaging over a window is a much closer approximation. It is still an
// approximation: the exact composite index weights are not published, and this
// reads a single venue's spot price. That limitation is stated rather than
// hidden — but approximating the right quantity beats measuring the wrong one
// precisely.
// ============================================================================

const MAX_AGE_MS = 15 * 60 * 1000; // keep 15 min of history; windows are <= 30 min

class PriceTape {
  constructor(maxAgeMs = MAX_AGE_MS) {
    this.maxAgeMs = maxAgeMs;
    this.tapes = new Map(); // symbol -> [{ ts, price }]
  }

  push(symbol, price, ts = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    if (!this.tapes.has(symbol)) this.tapes.set(symbol, []);
    const tape = this.tapes.get(symbol);
    tape.push({ ts, price });
    const cutoff = ts - this.maxAgeMs;
    while (tape.length && tape[0].ts < cutoff) tape.shift();
  }

  latest(symbol) {
    const tape = this.tapes.get(symbol);
    return tape && tape.length ? tape[tape.length - 1] : null;
  }

  // Time-weighted average price over [fromTs, toTs].
  //
  // Each sample is weighted by how long it stood as the most recent observation,
  // which is what makes this time-weighted rather than a plain mean of ticks —
  // sampling is not perfectly regular, so a plain mean would over-weight bursts.
  twap(symbol, fromTs, toTs) {
    const tape = this.tapes.get(symbol);
    if (!tape || !tape.length) return null;
    const inWindow = tape.filter((s) => s.ts >= fromTs && s.ts <= toTs);
    if (!inWindow.length) return null;

    if (inWindow.length === 1) {
      return { price: inWindow[0].price, samples: 1, spanMs: 0, method: 'single-sample' };
    }

    let weighted = 0;
    let totalMs = 0;
    for (let i = 0; i < inWindow.length - 1; i++) {
      const dt = inWindow[i + 1].ts - inWindow[i].ts;
      if (dt <= 0) continue;
      weighted += inWindow[i].price * dt;
      totalMs += dt;
    }
    // The final sample holds until the end of the window.
    const tailDt = Math.max(0, toTs - inWindow[inWindow.length - 1].ts);
    if (tailDt > 0) {
      weighted += inWindow[inWindow.length - 1].price * tailDt;
      totalMs += tailDt;
    }
    if (totalMs <= 0) {
      const mean = inWindow.reduce((a, s) => a + s.price, 0) / inWindow.length;
      return { price: mean, samples: inWindow.length, spanMs: 0, method: 'mean-fallback' };
    }
    return {
      price: weighted / totalMs,
      samples: inWindow.length,
      spanMs: totalMs,
      method: 'twap',
    };
  }

  stats(symbol) {
    const tape = this.tapes.get(symbol);
    if (!tape || !tape.length) return { samples: 0 };
    return {
      samples: tape.length,
      oldest: tape[0].ts,
      newest: tape[tape.length - 1].ts,
      spanSec: Math.round((tape[tape.length - 1].ts - tape[0].ts) / 1000),
    };
  }
}

module.exports = { PriceTape, MAX_AGE_MS };
```


## `lib/sizing.js`

```javascript
'use strict';

// ============================================================================
// sizing.js — how much to stake, derived from the measured edge.
//
// A professional does not size by how confident a signal FEELS; they size by
// how large the edge is and how well it is measured. Two signals both labelled
// "high confidence" deserve very different stakes if one rests on 400 resolved
// outcomes and the other on 31.
//
// The formula is Kelly for a binary payout b:
//
//     f* = (p·(1+b) − 1) / b
//
// f* is the fraction of bankroll that maximises long-run growth. Three things
// are done to it before it is ever shown to a user:
//
// 1. It is computed from the CONSERVATIVE probability (lower confidence bound),
//    never the point estimate. Kelly is extremely sensitive to overestimating p:
//    overbetting compounds toward ruin while underbetting only costs some upside.
//
// 2. It is multiplied by a fraction (default 0.25). Quarter-to-half Kelly is
//    standard practice precisely because the true p is never known exactly.
//
// 3. It is hard-capped as a percentage of bankroll, regardless of what the maths
//    suggests. A binary contract cannot be stopped out — there is no exit at a
//    better price, so a single position is all-or-nothing on that stake.
//
// The result is that "large stake" here means something like 3-5% of bankroll,
// not 50%. Any tool that suggests staking half your account on a 10-minute
// price prediction is not sizing, it is gambling.
// ============================================================================

const cal = require('./calibration');

const DEFAULTS = {
  bankroll: 1000,
  kellyFractionMultiplier: 0.25, // quarter Kelly
  maxStakePct: 5,                // hard ceiling per position
  minStakePct: 0.5,              // below this it is not worth the fees/attention
  // Sample-size shrinkage: an edge measured on few outcomes is discounted.
  fullTrustSamples: 200,
};

// Tiers exist for at-a-glance emphasis in the UI. They are driven by the SIZE OF
// THE EDGE (conservative probability above break-even), not by the raw score.
const TIERS = [
  { key: 'maxima', label: 'MAXIMĂ',  minEdgePct: 8 },
  { key: 'mare',   label: 'MARE',    minEdgePct: 4 },
  { key: 'medie',  label: 'MEDIE',   minEdgePct: 2 },
  { key: 'mica',   label: 'MICĂ',    minEdgePct: 0 },
];

function tierFor(edgePct) {
  return TIERS.find((t) => edgePct >= t.minEdgePct) || TIERS[TIERS.length - 1];
}

// Confidence in the ESTIMATE itself, from sample size. Ranges 0..1 and is used
// to shrink the stake when the underlying statistics are thin.
function sampleTrust(n, fullTrustSamples) {
  if (!n || n <= 0) return 0;
  return Math.min(1, Math.sqrt(n / fullTrustSamples));
}

// Compute a recommended stake for a gated signal.
//
// `gate` is the object returned by calibration.decide(): it already contains the
// conservative probability and whether the trade clears break-even.
function recommend(gate, payoutPct, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const bankroll = Number(cfg.bankroll) > 0 ? Number(cfg.bankroll) : DEFAULTS.bankroll;

  // No stake without an approved, measured edge. This is not conservatism for
  // its own sake: sizing off an unknown probability is undefined, not risky.
  if (!gate || !gate.trade || gate.conservative == null) {
    return {
      stake: 0,
      pctOfBankroll: 0,
      tier: null,
      tierLabel: 'FĂRĂ POZIȚIE',
      edgePct: null,
      kellyFull: null,
      kellyUsed: null,
      trust: 0,
      reason: gate && gate.needsData
        ? 'nu există probabilitate măsurată — nu se poate dimensiona nimic'
        : 'poarta EV nu a aprobat semnalul',
      warnings: [],
    };
  }

  const p = gate.conservative;           // conservative, not optimistic
  const be = gate.breakEven;
  const edgePct = +(p - be).toFixed(2);  // percentage points above break-even

  const kellyFull = cal.kellyFraction(p, payoutPct);          // 0..1
  const trust = sampleTrust(gate.n, cfg.fullTrustSamples);
  const kellyUsed = kellyFull * cfg.kellyFractionMultiplier * trust;

  let pct = kellyUsed * 100;
  const warnings = [];

  if (pct > cfg.maxStakePct) {
    warnings.push(`Kelly sugera ${pct.toFixed(1)}% din capital; plafonat la ${cfg.maxStakePct}%. Un contract binar nu poate fi închis în pierdere parțială.`);
    pct = cfg.maxStakePct;
  }
  if (pct < cfg.minStakePct) {
    return {
      stake: 0,
      pctOfBankroll: 0,
      tier: 'mica',
      tierLabel: 'PREA MIC',
      edgePct,
      kellyFull: +(kellyFull * 100).toFixed(2),
      kellyUsed: +(kellyUsed * 100).toFixed(2),
      trust: +trust.toFixed(2),
      reason: `edge-ul (${edgePct} puncte peste pragul de rentabilitate) justifică doar ${pct.toFixed(2)}% din capital — sub minimul de ${cfg.minStakePct}%, nu merită intrat`,
      warnings,
    };
  }

  if (trust < 0.5) {
    warnings.push(`Statistică subțire: ${gate.n} rezultate. Miza e redusă proporțional (încredere ${(trust * 100).toFixed(0)}%). Va crește pe măsură ce jurnalul se umple.`);
  }

  const tier = tierFor(edgePct);
  const stake = +((pct / 100) * bankroll).toFixed(2);

  return {
    stake,
    pctOfBankroll: +pct.toFixed(2),
    tier: tier.key,
    tierLabel: tier.label,
    edgePct,
    kellyFull: +(kellyFull * 100).toFixed(2),
    kellyUsed: +(kellyUsed * 100).toFixed(2),
    trust: +trust.toFixed(2),
    bankroll,
    reason: `probabilitate prudentă ${p}% vs prag ${be}% ⇒ edge ${edgePct} puncte · Kelly integral ${(kellyFull * 100).toFixed(1)}% × ${cfg.kellyFractionMultiplier} × încredere ${(trust * 100).toFixed(0)}%`,
    warnings,
  };
}

module.exports = { recommend, tierFor, sampleTrust, TIERS, DEFAULTS };
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

const candles = require('./candles');

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
//
// The last row the exchange returns is the candle currently FORMING: its
// high/low/close/volume keep changing until the bar closes. Feeding it to the
// detectors makes verdicts mutate mid-bar (repainting) and breaks any
// correspondence with the backtest, which only ever replays completed bars.
// So we over-fetch by one row and hand back only confirmed candles, plus the
// forming candle separately for price display.
async function fetchMultiTimeframe(symbol, timeframes = ['5m', '15m', '30m'], limit = 200, opts = {}) {
  const closedOnly = opts.closedOnly !== false;
  const results = {};
  const forming = {};
  await Promise.all(
    timeframes.map(async (tf) => {
      const raw = await fetchKlines(symbol, tf, limit + (closedOnly ? 1 : 0));
      if (!closedOnly) { results[tf] = raw; return; }
      const { closed, forming: f } = candles.split(raw);
      results[tf] = closed.slice(-limit);
      forming[tf] = f;
    })
  );
  if (closedOnly) Object.defineProperty(results, '__forming', { value: forming, enumerable: false });
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
  //
  // IMPORTANT: an MSS is an EVENT, not a state. The previous version only
  // checked `lastClose > lastSwingHigh`, which stays true for every bar that
  // price holds above the level — so a single break kept injecting weight into
  // the score for dozens of consecutive bars, inflating confluence. We now
  // require the break to be NEW: the prior bar must still have been on the other
  // side of the level. `mssState` keeps the persistent view for display.
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx].close;
  const prevClose = lastIdx > 0 ? candles[lastIdx - 1].close : lastClose;
  const lastSwingHigh = highs[highs.length - 1].price;
  const lastSwingLow = lows[lows.length - 1].price;

  let mssState = null;
  if (lastClose > lastSwingHigh && (trend === 'down' || trend === 'range')) mssState = 'bullish';
  if (lastClose < lastSwingLow && (trend === 'up' || trend === 'range')) mssState = 'bearish';

  let mss = null;
  if (mssState === 'bullish' && prevClose <= lastSwingHigh) mss = 'bullish';
  if (mssState === 'bearish' && prevClose >= lastSwingLow) mss = 'bearish';

  return {
    trend,
    mss,        // fresh break on this bar only (a trigger)
    mssState,   // persistent "price is beyond the level" view (context)
    detail: { higherHighs, higherLows, lowerHighs, lowerLows, lastSwingHigh, lastSwingLow },
    highs,
    lows,
  };
}

// ---- Fair Value Gaps --------------------------------------------------------
// A 3-candle imbalance. Bullish: low[i] > high[i-2]. Bearish: high[i] < low[i-2].
//
// Lifecycle of a gap (this is what the previous version got wrong — it tracked
// inversion but never tracked FILLING, so a gap that had been fully consumed
// weeks ago still counted as a live "retest"):
//   fresh      -> price has not returned into the zone yet
//   retesting  -> price is inside the zone right now (tradeable)
//   filled     -> price reached the far edge; the imbalance is spent (NOT tradeable)
//   inverted   -> price CLOSED through the zone; polarity flips (IFVG, tradeable)
// `opts.atr` enables the significance filters described below. Without it the
// function degrades to the raw 3-bar pattern (kept only for compatibility).
function fairValueGaps(candles, lookback = 60, opts = {}) {
  const atr = Number.isFinite(opts.atr) && opts.atr > 0 ? opts.atr : null;
  // A Fair Value Gap is supposed to mark DISPLACEMENT — a violent, one-sided move
  // that leaves unfilled orders behind. The mechanical "low[i] > high[i-2]" test
  // alone matches a huge number of trivial 3-bar patterns: measured on 4000 bars,
  // price sat inside some qualifying gap 76% of the time, and FVG/IFVG accounted
  // for 93% of all triggers, drowning out every other setup. That is ambient
  // noise being reported as a signal.
  //
  // Two significance filters restore the intended meaning:
  //   minGapAtr          - the gap itself must be a real void, not a rounding error
  //   minDisplacementAtr - the middle candle must be an expansion candle
  const minGapAtr = opts.minGapAtr != null ? opts.minGapAtr : 0.35;
  const minDisplacementAtr = opts.minDisplacementAtr != null ? opts.minDisplacementAtr : 0.9;

  const start = Math.max(2, candles.length - lookback);
  const gaps = [];
  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2];
    const mid = candles[i - 1];
    const c = candles[i];
    const displacement = Math.abs(mid.close - mid.open);

    // Bullish FVG: imbalance left BELOW price.
    if (c.low > a.high) {
      const size = c.low - a.high;
      if (!atr || (size >= minGapAtr * atr && displacement >= minDisplacementAtr * atr)) {
        gaps.push({ type: 'bullish', top: c.low, bottom: a.high, index: i, size, displacement });
      }
    }
    // Bearish FVG: imbalance left ABOVE price.
    if (c.high < a.low) {
      const size = a.low - c.high;
      if (!atr || (size >= minGapAtr * atr && displacement >= minDisplacementAtr * atr)) {
        gaps.push({ type: 'bearish', top: a.low, bottom: c.high, index: i, size, displacement });
      }
    }
  }

  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx].close;
  const lastHigh = candles[lastIdx].high;
  const lastLow = candles[lastIdx].low;

  // Maximum age (in bars) for a gap, or for an inversion, to still be relevant.
  const maxAge = opts.maxAge != null ? opts.maxAge : 30;
  const maxInversionAge = opts.maxInversionAge != null ? opts.maxInversionAge : 12;

  const inZone = (candle, g) => candle.low <= g.top && candle.high >= g.bottom;

  const enriched = gaps.map((g) => {
    let touchedAt = null;        // first re-entry into the zone
    let filledAt = null;         // first time the far edge was reached
    let invertedAt = null;       // first CLOSE beyond the zone (polarity flip)
    let postInversionTouchAt = null; // first re-entry AFTER the flip

    for (let k = g.index + 1; k < candles.length; k++) {
      const c = candles[k];
      const cl = c.close;
      if (touchedAt == null && inZone(c, g)) touchedAt = k;
      if (g.type === 'bullish') {
        if (filledAt == null && c.low <= g.bottom) filledAt = k;
        if (invertedAt == null && cl < g.bottom) invertedAt = k;
      } else {
        if (filledAt == null && c.high >= g.top) filledAt = k;
        if (invertedAt == null && cl > g.top) invertedAt = k;
      }
      if (invertedAt != null && k > invertedAt && postInversionTouchAt == null && inZone(c, g)) {
        postInversionTouchAt = k;
      }
    }

    const inverted = invertedAt != null;
    const effectiveType = inverted ? (g.type === 'bullish' ? 'bearish' : 'bullish') : g.type;

    // A gap is only ACTIONABLE on a specific bar, not permanently:
    //
    //   plain FVG -> the FIRST time price returns into an unmitigated gap.
    //   IFVG      -> the FIRST return after a recent polarity flip.
    //
    // Without this, a single gap kept re-emitting a signal on every bar price
    // happened to drift through it. Because almost every gap eventually gets
    // closed through on a long enough lookback, nearly all of them ended up
    // classified as tradeable inversions: FVG/IFVG produced 88-93% of all
    // triggers and masked every other setup.
    let actionable = false;
    let reason = null;
    if (inverted) {
      const freshFlip = lastIdx - invertedAt <= maxInversionAge;
      if (freshFlip && postInversionTouchAt === lastIdx) {
        actionable = true;
        reason = 'primul retest după inversare';
      }
    } else if (filledAt == null || filledAt === lastIdx) {
      const fresh = lastIdx - g.index <= maxAge;
      if (fresh && touchedAt === lastIdx) {
        actionable = true;
        reason = 'primul retest al gap-ului nemitigat';
      }
    }

    return {
      ...g,
      inverted,
      invertedAt,
      filled: filledAt != null,
      filledAt,
      touchedAt,
      spent: filledAt != null && invertedAt == null,
      actionable,
      reason,
      effectiveType,
      age: lastIdx - g.index,
    };
  });

  // Only gaps that are actionable ON THIS BAR, and price is currently inside.
  const candidates = enriched.filter((g) => g.actionable && lastLow <= g.top && lastHigh >= g.bottom);
  // Pick the MOST RECENT one. The previous version used .find(), which returned
  // the OLDEST match — usually a stale, irrelevant gap.
  const retest = candidates.length
    ? candidates.reduce((best, g) => (g.index > best.index ? g : best), candidates[0])
    : null;

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

// ---- Trigger taxonomy (SINGLE SOURCE OF TRUTH) -----------------------------
// Previously this classification lived as three separate copies of a regex in
// engine.js, server.js and backtest.js. They drifted, which meant the live app,
// the journal and the backtest could each disagree about what "the setup" was.
//
// Each entry also declares the contract window the setup naturally belongs to:
//   10 minute -> impulsive, single-bar rejection/expansion events
//   30 minute -> structural setups that need room to play out
//
// This replaces the old horizon rule, which compared the SUMMED weight of all
// "fast" signals against all "structural" signals. Because context signals
// (trend, EMA alignment, VWAP, 1h alignment) are present on almost every bar
// while true triggers are rare, structural weight nearly always won: measured on
// 4000 bars, only 2.4% of signals came out as 10-minute. The window is now taken
// from the PRIMARY trigger, so both windows genuinely occur.
const TRIGGERS = [
  { re: /liquidity sweep/i,                  setup: 'Liquidity Sweep',        horizon: '10 minute' },
  { re: /squeeze/i,                          setup: 'Squeeze breakout',       horizon: '10 minute' },
  { re: /absorb|distribuție|oprire/i,        setup: 'Volume absorption',      horizon: '10 minute' },
  { re: /bandă bollinger|reversie la medie/i, setup: 'Bollinger bounce',      horizon: '10 minute' },
  { re: /crossover/i,                        setup: 'MACD crossover',         horizon: '10 minute' },
  { re: /market structure shift/i,           setup: 'Market Structure Shift', horizon: '30 minute' },
  { re: /ifvg/i,                             setup: 'Inversion FVG',          horizon: '30 minute' },
  { re: /fvg/i,                              setup: 'FVG retest',             horizon: '30 minute' },
  { re: /divergen/i,                         setup: 'RSI divergence',         horizon: '30 minute' },
];

// Classify a signal label into { setup, horizon }, or null if it is mere context.
function classifyTrigger(label) {
  if (!label) return null;
  for (const t of TRIGGERS) {
    if (t.re.test(label)) return { setup: t.setup, horizon: t.horizon };
  }
  return null;
}

const isTrigger = (label) => classifyTrigger(label) !== null;

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
  const atrSeries = ind.atr(highs, lows, closes, 14) || [];

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

  const atrNow = ind.last(atrSeries);
  const structure = smc.marketStructure(candles, 2);
  // ATR is passed so the FVG detector can require genuine displacement instead
  // of matching every trivial 3-bar imbalance.
  const fvg = smc.fairValueGaps(candles, 60, { atr: atrNow });
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
    atr: atrNow != null ? +atrNow.toFixed(2) : null,
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
  let noTrigger = false;
  // The highest-weight genuine trigger on the winning side defines the setup.
  let primaryTrigger = null;
  if (directie !== 'NEUTRU') {
    primaryTrigger = winning.find((s) => isTrigger(s.label)) || null;
    if (!primaryTrigger) {
      directie = 'NEUTRU';
      noTrigger = true;
    }
  }

  // Interval comes from the PRIMARY TRIGGER's natural window (see TRIGGERS).
  const triggerInfo = primaryTrigger ? classifyTrigger(primaryTrigger.label) : null;
  const setup = triggerInfo ? triggerInfo.setup : 'context';
  const interval = triggerInfo ? triggerInfo.horizon : '30 minute';

  // Kept for display/diagnostics only — no longer decides the window.
  let winFast = 0;
  let winStruct = 0;
  for (const s of winning) {
    if (s.kind === 'fast') winFast += s.weight;
    else winStruct += s.weight;
  }

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
    justificare = `Declanșator principal: ${primaryTrigger.label} [${primaryTrigger.tf}]. ` +
      `Confluență ${directie} pe ${confluence} semnale: ${top.join('; ')}. ` +
      (interval === '10 minute'
        ? 'Este un eveniment impulsiv de o singură lumânare, deci fereastra scurtă (10 min) captează cel mai bine mișcarea.'
        : 'Este un setup structural, deci are nevoie de spațiu de desfășurare (30 min).');
  }

  // Identity of the bar this verdict was computed from. Because the engine now
  // only ever sees CLOSED candles, (symbol, barCloseTime) uniquely identifies a
  // verdict — which lets the server emit exactly one alert per bar instead of
  // re-evaluating the same bar on every poll.
  const fastest = tf5 && tf5.length ? tf5 : tf15;
  const lastBar = fastest && fastest.length ? fastest[fastest.length - 1] : null;

  return {
    directie,
    interval,
    justificare,
    incredere,
    invalidare,
    setup,
    primaryTrigger: primaryTrigger
      ? { label: primaryTrigger.label, tf: primaryTrigger.tf, weight: +primaryTrigger.weight.toFixed(2) }
      : null,
    score: +absNet.toFixed(2),
    scores: { up: +upScore.toFixed(2), down: +downScore.toFixed(2), net: +net.toFixed(2) },
    confluence,
    weightSplit: { fast: +winFast.toFixed(2), structural: +winStruct.toFixed(2) },
    signals: winning.map((s) => ({ label: s.label, tf: s.tf, weight: +s.weight.toFixed(2), kind: s.kind })),
    allSignals: allSignals.map((s) => ({ side: s.side, label: s.label, tf: s.tf, weight: +s.weight.toFixed(2) })),
    snapshots: Object.fromEntries(analyses.map((a) => [a.tf, a.snapshot])),
    htfTrend,
    price,
    barOpenTime: lastBar ? lastBar.openTime : null,
    barCloseTime: lastBar ? lastBar.closeTime : null,
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

module.exports = {
  decide,
  analyzeTimeframe,
  rsiDivergence,
  sniperEligibility,
  classifyTrigger,
  isTrigger,
  TRIGGERS,
};
```


## `lib/calibration.js`

```javascript
'use strict';

// ============================================================================
// calibration.js — the event-futures decision layer.
//
// WHY THIS EXISTS
// A binary event contract does not pay you for being directionally right; it
// pays you for being right MORE OFTEN THAN THE PAYOUT REQUIRES. With a payout of
// p (e.g. 0.65 for +65%), staking 1 unit returns +p on a win and -1 on a loss,
// so expected value is:
//
//     EV = w*p - (1-w)        where w = true win probability
//
// EV turns positive only when w > 1/(1+p). That break-even is brutal:
//
//     payout 40% -> need 71.4%      payout 65% -> need 60.6%
//     payout 80% -> need 55.6%      payout 85% -> need 54.1%
//
// So the only number that matters for this instrument is a CALIBRATED
// probability — "70%" has to mean the thing actually happens 70% of the time.
// A raw confluence score ("net = 6.19") is not a probability and must never be
// treated as one.
//
// WHAT THIS MODULE DOES
//   fit()      -> learns score/setup buckets -> empirical win rate, from history
//   predict()  -> maps a new signal to a probability WITH an uncertainty interval
//   decide()   -> compares the CONSERVATIVE bound against break-even
//
// WHAT IT DELIBERATELY WILL NOT DO
// It never invents a probability. If a bucket has too few resolved samples, it
// reports ready:false and the app must say "not enough data" rather than print a
// confident-looking number. Uncertainty is surfaced, not hidden.
// ============================================================================

const DEFAULT_MIN_SAMPLE = 30;   // per-bucket minimum before a rate is trusted
const Z_95 = 1.959963985;        // two-sided 95%
const Z_ONE_SIDED_90 = 1.2815516; // for the conservative lower bound

// ---- Event-futures arithmetic ----------------------------------------------

// Win rate (%) needed just to break even at a given payout (%).
function breakEvenWinRate(payoutPct) {
  const p = Number(payoutPct) / 100;
  if (!Number.isFinite(p) || p <= 0) return null;
  return +((100 / (1 + p))).toFixed(2);
}

// Expected value per 1 unit staked, as a percentage of the stake.
function expectedValue(winRatePct, payoutPct) {
  const w = Number(winRatePct) / 100;
  const p = Number(payoutPct) / 100;
  if (!Number.isFinite(w) || !Number.isFinite(p)) return null;
  return +(((w * p) - (1 - w)) * 100).toFixed(2);
}

// Kelly-optimal fraction of bankroll for a binary payout. Reported for context
// only — it assumes the probability is exactly right, which it never is.
function kellyFraction(winRatePct, payoutPct) {
  const w = Number(winRatePct) / 100;
  const p = Number(payoutPct) / 100;
  if (!Number.isFinite(w) || !Number.isFinite(p) || p <= 0) return 0;
  const f = (w * (1 + p) - 1) / p;
  return +Math.max(0, Math.min(1, f)).toFixed(4);
}

// ---- Statistics ------------------------------------------------------------

// Wilson score interval — well behaved for small n and for rates near 0/1,
// unlike the normal approximation.
function wilson(wins, n, z = Z_95) {
  if (!n) return { low: null, high: null, mid: null };
  const phat = wins / n;
  const z2n = (z * z) / n;
  const denom = 1 + z2n;
  const center = (phat + z2n / 2) / denom;
  const half = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  return {
    low: +Math.max(0, (center - half) * 100).toFixed(2),
    high: +Math.min(1, (center + half) * 100).toFixed(2),
    mid: +(phat * 100).toFixed(2),
  };
}

// One-sided binomial test against a fair coin: "is this better than 50%?"
// Returns the z statistic and an approximate p-value. This is the honesty check
// that separates a real edge from a lucky streak.
function vsCoinFlip(wins, n) {
  if (!n) return { z: null, pValue: null, significant: false };
  const phat = wins / n;
  const se = Math.sqrt(0.25 / n);
  const z = (phat - 0.5) / se;
  // Normal tail approximation (Abramowitz & Stegun 7.1.26 style erf).
  const erf = (x) => {
    const s = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return s * y;
  };
  const pValue = +(0.5 * (1 - erf(z / Math.SQRT2))).toFixed(4);
  return { z: +z.toFixed(2), pValue, significant: pValue < 0.05 };
}

// Brier score: mean squared error of probabilistic forecasts. Lower is better;
// 0.25 is what you get by always saying 50%.
function brierScore(samples) {
  const usable = samples.filter((s) => Number.isFinite(s.probability) && typeof s.win === 'boolean');
  if (!usable.length) return null;
  const sum = usable.reduce((acc, s) => {
    const p = s.probability / 100;
    return acc + (p - (s.win ? 1 : 0)) ** 2;
  }, 0);
  return +(sum / usable.length).toFixed(4);
}

// Reliability table: are forecasts of "X%" actually right X% of the time?
function reliability(samples, binCount = 5) {
  const usable = samples.filter((s) => Number.isFinite(s.probability) && typeof s.win === 'boolean');
  const bins = [];
  for (let i = 0; i < binCount; i++) {
    const lo = 40 + (i * 30) / binCount;   // focus on the 40-70% region that matters
    const hi = 40 + ((i + 1) * 30) / binCount;
    const inBin = usable.filter((s) => s.probability >= lo && s.probability < hi);
    const wins = inBin.filter((s) => s.win).length;
    bins.push({
      range: `${lo.toFixed(0)}-${hi.toFixed(0)}%`,
      n: inBin.length,
      predicted: inBin.length ? +(inBin.reduce((a, s) => a + s.probability, 0) / inBin.length).toFixed(1) : null,
      actual: inBin.length ? +((wins / inBin.length) * 100).toFixed(1) : null,
    });
  }
  return bins;
}

// ---- Score bucketing -------------------------------------------------------

// Confluence score |net| is ordinal, not probabilistic. We bin it and let the
// data say what each bin is worth.
const SCORE_BINS = [
  { key: 's1', min: 0, max: 2.5 },
  { key: 's2', min: 2.5, max: 4 },
  { key: 's3', min: 4, max: 5.5 },
  { key: 's4', min: 5.5, max: 7 },
  { key: 's5', min: 7, max: Infinity },
];

function scoreBin(score) {
  const s = Math.abs(Number(score) || 0);
  const b = SCORE_BINS.find((x) => s >= x.min && s < x.max);
  return b ? b.key : 's1';
}

// ---- Fitting ---------------------------------------------------------------

function aggregate(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const ci = wilson(wins, n);
  // The gate asks a ONE-SIDED question: "is the true rate above the threshold?"
  // A two-sided 95% bound is the wrong tool for that and rejects genuine edges
  // needlessly, so a one-sided 90% bound is reported alongside for the decision.
  // The two-sided interval is still what gets displayed, since it is the honest
  // summary of uncertainty in both directions.
  const oneSided = wilson(wins, n, Z_ONE_SIDED_90);
  return {
    n,
    wins,
    winRate: n ? +((wins / n) * 100).toFixed(2) : null,
    ciLow: ci.low,
    ciHigh: ci.high,
    ciLow90: oneSided.low,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const out = {};
  for (const [k, v] of map) out[k] = aggregate(v);
  return out;
}

// Build a calibration model from resolved samples.
// Each sample: { setup, interval, direction, score, win }
function fit(samples, opts = {}) {
  const minSample = opts.minSample || DEFAULT_MIN_SAMPLE;
  const rows = (samples || []).filter((s) => typeof s.win === 'boolean');
  return {
    version: 2,
    fittedAt: Date.now(),
    minSample,
    total: rows.length,
    global: aggregate(rows),
    byInterval: groupBy(rows, (r) => r.interval),
    bySetupInterval: groupBy(rows, (r) => `${r.setup}|${r.interval}`),
    bySetupIntervalScore: groupBy(rows, (r) => `${r.setup}|${r.interval}|${scoreBin(r.score)}`),
  };
}

// ---- Prediction ------------------------------------------------------------

// Hierarchical lookup: most specific bucket with enough samples wins.
// Returns { ready, probability, ciLow, ciHigh, n, source }.
function predict(model, ctx) {
  if (!model || !model.total) {
    return { ready: false, probability: null, ciLow: null, ciHigh: null, n: 0, source: 'niciun model calibrat' };
  }
  const minSample = model.minSample || DEFAULT_MIN_SAMPLE;
  const candidates = [
    { bucket: model.bySetupIntervalScore?.[`${ctx.setup}|${ctx.interval}|${scoreBin(ctx.score)}`], source: `${ctx.setup} · ${ctx.interval} · scor ${scoreBin(ctx.score)}` },
    { bucket: model.bySetupInterval?.[`${ctx.setup}|${ctx.interval}`], source: `${ctx.setup} · ${ctx.interval}` },
    { bucket: model.byInterval?.[ctx.interval], source: `toate setup-urile · ${ctx.interval}` },
    { bucket: model.global, source: 'global' },
  ];
  for (const c of candidates) {
    if (c.bucket && c.bucket.n >= minSample && c.bucket.winRate != null) {
      return {
        ready: true,
        probability: c.bucket.winRate,
        ciLow: c.bucket.ciLow,
        ciHigh: c.bucket.ciHigh,
        ciLow90: c.bucket.ciLow90,
        n: c.bucket.n,
        source: c.source,
      };
    }
  }
  const best = candidates.find((c) => c.bucket && c.bucket.n > 0);
  return {
    ready: false,
    probability: null,
    ciLow: null,
    ciHigh: null,
    n: best ? best.bucket.n : 0,
    source: `date insuficiente (nevoie de ${minSample} rezultate, am ${best ? best.bucket.n : 0})`,
  };
}

// ---- The actual trade/skip decision ---------------------------------------
//
// Deliberately conservative: it compares the LOWER bound of the confidence
// interval against break-even, not the point estimate. A raw 56% off 25 samples
// has a lower bound near 40% — that is not an edge, it is noise, and this gate
// refuses it. Being slow to say yes is the correct failure mode when the
// alternative is losing money.
function decide(prediction, payoutPct, opts = {}) {
  const marginPct = opts.marginPct != null ? opts.marginPct : 1.5; // required cushion
  const be = breakEvenWinRate(payoutPct);
  if (be == null) {
    return { trade: false, reason: 'payout invalid', breakEven: null };
  }
  if (!prediction || !prediction.ready) {
    return {
      trade: false,
      reason: prediction ? prediction.source : 'fără predicție calibrată',
      breakEven: be,
      needsData: true,
    };
  }
  const required = be + marginPct;
  // One-sided 90% lower bound: the appropriate bound for a directional threshold
  // test. Falls back to the two-sided bound if a caller supplies only that.
  const conservative = prediction.ciLow90 != null ? prediction.ciLow90 : prediction.ciLow;
  const ev = expectedValue(prediction.probability, payoutPct);
  const evConservative = expectedValue(conservative, payoutPct);
  const trade = conservative != null && conservative >= required;
  return {
    trade,
    breakEven: be,
    required: +required.toFixed(2),
    probability: prediction.probability,
    conservative,
    ev,
    evConservative,
    kelly: trade ? kellyFraction(conservative, payoutPct) : 0,
    n: prediction.n,
    source: prediction.source,
    reason: trade
      ? `probabilitate conservatoare ${conservative}% ≥ prag ${required.toFixed(1)}% (payout ${payoutPct}%)`
      : `probabilitate conservatoare ${conservative}% < prag ${required.toFixed(1)}% necesar la payout ${payoutPct}% — EV negativ, se sare`,
  };
}

module.exports = {
  breakEvenWinRate,
  expectedValue,
  kellyFraction,
  wilson,
  vsCoinFlip,
  brierScore,
  reliability,
  scoreBin,
  SCORE_BINS,
  fit,
  predict,
  decide,
  DEFAULT_MIN_SAMPLE,
};
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
  // GUARD: the previous version used `if (t.m === false) buy; else sell;` — so if
  // the exchange ever omitted or renamed `m`, EVERY trade was silently counted as
  // an aggressive sell, manufacturing a permanent bearish bias. We now require a
  // real boolean and count unusable rows separately instead of guessing.
  let buyVol = 0;
  let sellVol = 0;
  let skipped = 0;
  if (Array.isArray(trades)) {
    for (const t of trades) {
      const q = Number(t.q);
      if (!Number.isFinite(q) || typeof t.m !== 'boolean') { skipped++; continue; }
      if (t.m === false) buyVol += q; // buyer is taker -> aggressive BUY
      else sellVol += q;              // buyer is maker -> aggressive SELL
    }
  }
  // If we could not classify a meaningful share of trades, the delta is not
  // trustworthy — report it as unavailable rather than as a directional read.
  const usable = (Array.isArray(trades) ? trades.length : 0) - skipped;
  const deltaReliable = usable > 0 && skipped / Math.max(1, trades.length) < 0.2;
  const delta = deltaReliable && buyVol + sellVol > 0 ? (buyVol - sellVol) / (buyVol + sellVol) : 0;

  // Combined pressure and a discrete state. If the trade delta is unusable we
  // fall back to book imbalance alone rather than averaging in a fake zero.
  const pressure = deltaReliable ? (imbalance + delta) / 2 : imbalance;
  let state = 'neutru';
  if (pressure > 0.15) state = 'buy';
  else if (pressure < -0.15) state = 'sell';

  return {
    imbalance: +imbalance.toFixed(3),
    delta: +delta.toFixed(3),
    deltaReliable,
    skippedTrades: skipped,
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
    // Raw confluence score, kept so the calibration layer can bucket by it.
    score: sig.score != null ? sig.score : null,
    // What the model believed at signal time — needed to check calibration
    // afterwards ("did the 62% signals actually win 62% of the time?").
    probability: sig.probability != null ? sig.probability : null,
    stake: sig.stake != null ? sig.stake : null,
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

// Resolve any pending entries whose window has elapsed.
//
// `settle(symbol, resolveTs)` must return either a number or
// { price, method, samples }. It is expected to produce a TIME-WEIGHTED AVERAGE
// over the seconds immediately before expiry, because that is how MEXC states
// Up/Down settlement prices are determined. Grading against a single tick — what
// this function used to do — measures a different outcome from the one that
// actually pays, and a late wick can flip it either way.
async function resolvePending(settle, opts = {}) {
  const now = Date.now();
  // Small grace period so the settlement window has samples in it before we read.
  const graceMs = opts.graceMs != null ? opts.graceMs : 5000;
  const resolved = [];
  let changed = false;
  for (const e of entries) {
    if (e.status !== 'pending' || now < e.resolveTs + graceMs) continue;
    try {
      const out = await settle(e.symbol, e.resolveTs);
      const price = typeof out === 'number' ? out : (out && out.price);
      if (!Number.isFinite(price)) continue;
      e.exitPrice = price;
      e.settlement = typeof out === 'object' && out
        ? { method: out.method, samples: out.samples }
        : { method: 'last-price', samples: 1 };
      // A dead-flat outcome is not a win. MEXC does not publish its tie rule for
      // these contracts, so the pessimistic reading is used deliberately: this
      // is a self-grading journal, and flattering yourself here costs money.
      e.win = e.directie === 'UP' ? price > e.entryPrice : price < e.entryPrice;
      e.tie = price === e.entryPrice;
      e.status = 'resolved';
      changed = true;
      resolved.push(e);
    } catch {
      /* try again next cycle */
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
//
// Three defects in the previous version made its numbers unusable:
//
// 1. NO PARITY WITH LIVE. It called engine.decide({'5m','15m'}) while the server
//    calls engine.decide({'5m','15m','60m'}). The 1h trend-alignment signal
//    (weight 1.5) therefore existed live but not in validation, so the two could
//    return different verdicts from the same data — verified: one returned
//    NEUTRU where the other returned UP. Whatever win-rate it printed described
//    a strategy nobody was running. It now feeds the exact same timeframes.
//
// 2. NO TRAIN/TEST SEPARATION. Win-rate was reported over the whole sample, then
//    the best-looking subset ("sweep + volume + active hours") was picked from
//    those same numbers. That is selecting a hypothesis on the data you then
//    quote as evidence for it. Calibration is now fitted on an EARLIER slice and
//    scored only on a LATER, untouched slice.
//
// 3. NO NULL BASELINE AND NO ERROR BARS. "54.8%" means nothing without knowing
//    what a coin flip scored on the same bars and how wide the interval is. Both
//    are now reported, plus a binomial test against 50%.
//
// Overlap: signals are spaced by at least the longest horizon so samples do not
// share outcome bars. Overlapping samples are correlated and would make the
// significance test look far stronger than it is.
// ============================================================================

const binance = require('./binance');
const engine = require('./engine');
const cal = require('./calibration');
const candles = require('./candles');

const WINDOW = 200;         // candles fed to the engine
const HORIZON_10 = 2;       // 2 x 5m = 10 min
const HORIZON_30 = 6;       // 6 x 5m = 30 min
const COOLDOWN = HORIZON_30; // non-overlapping samples

async function run(symbol, opts = {}) {
  const days = Math.min(60, Math.max(3, opts.days || 15));
  const endDaysAgo = Math.max(0, opts.endDaysAgo || 0);
  const trainFraction = Math.min(0.9, Math.max(0.3, opts.trainFraction || 0.6));
  const payout10 = opts.payout10 != null ? Number(opts.payout10) : 65;
  const payout30 = opts.payout30 != null ? Number(opts.payout30) : 82;
  const endTimeMs = endDaysAgo > 0 ? Date.now() - endDaysAgo * 86400 * 1000 : null;

  // PARITY: fetch every timeframe the live server uses, including 1h.
  const tf5 = await binance.fetchHistory(symbol, '5m', days, 1000, endTimeMs);
  const tf15 = await binance.fetchHistory(symbol, '15m', days, 1000, endTimeMs);
  const tf60 = await binance.fetchHistory(symbol, '1h', days, 1000, endTimeMs);

  if (tf5.length < WINDOW + HORIZON_30 + 10) {
    throw new Error(`istoric insuficient pentru ${symbol}: ${tf5.length} lumânări de 5m`);
  }

  const samples = [];
  let lastIdx = -Infinity;
  let neutralCount = 0;

  for (let i = WINDOW; i < tf5.length - HORIZON_30; i++) {
    const asOf = tf5[i].closeTime;
    const w5 = tf5.slice(i - WINDOW, i + 1);
    const w15 = candles.upTo(tf15, asOf).slice(-WINDOW);
    const w60 = candles.upTo(tf60, asOf).slice(-WINDOW);
    if (w15.length < 60) continue;

    const mtf = { '5m': w5, '15m': w15 };
    if (w60.length >= 60) mtf['60m'] = w60;

    let verdict;
    try {
      verdict = engine.decide(mtf);
    } catch {
      continue;
    }
    if (verdict.directie === 'NEUTRU') { neutralCount++; continue; }
    if (i - lastIdx < COOLDOWN) continue;
    lastIdx = i;

    const entry = tf5[i].close;
    const exit10 = tf5[i + HORIZON_10].close;
    const exit30 = tf5[i + HORIZON_30].close;
    const up = verdict.directie === 'UP';
    const win10 = up ? exit10 > entry : exit10 < entry;
    const win30 = up ? exit30 > entry : exit30 < entry;
    const natural = verdict.interval;

    samples.push({
      ts: tf5[i].openTime,
      time: new Date(tf5[i].openTime).toISOString(),
      hour: new Date(tf5[i].openTime).getUTCHours(),
      setup: verdict.setup,
      interval: natural,
      direction: verdict.directie,
      score: verdict.score,
      confidence: verdict.incredere,
      entry: +entry.toFixed(2),
      exit10: +exit10.toFixed(2),
      exit30: +exit30.toFixed(2),
      win10,
      win30,
      // Outcome at the window the engine actually chose.
      win: natural === '10 minute' ? win10 : win30,
      // Null baselines measured on the SAME bars.
      baselineUp10: exit10 > entry,
      baselineUp30: exit30 > entry,
    });
  }

  if (samples.length < 20) {
    return {
      symbol,
      days,
      source: 'binance.vision (proxy pentru istoric adânc)',
      totalCandles: tf5.length,
      neutralCount,
      evaluated: samples.length,
      error: `prea puține semnale (${samples.length}) pentru o concluzie. Mărește perioada.`,
    };
  }

  // ---- Time-ordered train/test split ---------------------------------------
  samples.sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(samples.length * trainFraction);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);

  // Fit calibration on TRAIN ONLY.
  const model = cal.fit(train, { minSample: opts.minSample || 30 });

  // Score the untouched TEST slice.
  const scored = test.map((s) => {
    const pred = cal.predict(model, { setup: s.setup, interval: s.interval, score: s.score });
    const payout = s.interval === '10 minute' ? payout10 : payout30;
    const gate = cal.decide(pred, payout, { marginPct: opts.marginPct });
    return { ...s, probability: pred.probability, predReady: pred.ready, gate };
  });

  const rate = (rows, field = 'win') => {
    const n = rows.length;
    const wins = rows.filter((r) => r[field]).length;
    const ci = cal.wilson(wins, n);
    const sig = cal.vsCoinFlip(wins, n);
    return {
      n,
      wins,
      winRate: n ? +((wins / n) * 100).toFixed(2) : null,
      ci95: n ? [ci.low, ci.high] : null,
      vsCoinFlip: sig,
    };
  };

  const byGroup = (rows, keyFn, field = 'win') => {
    const map = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    const out = {};
    for (const [k, v] of [...map.entries()].sort()) out[k] = rate(v, field);
    return out;
  };

  // Only the signals the EV gate would actually have approved.
  const approved = scored.filter((s) => s.gate.trade);

  // Baseline: what did "always bet UP" score on the very same test bars?
  const baseUp = rate(
    test.map((s) => ({ win: s.interval === '10 minute' ? s.baselineUp10 : s.baselineUp30 }))
  );
  const baseDown = rate(
    test.map((s) => ({ win: !(s.interval === '10 minute' ? s.baselineUp10 : s.baselineUp30) }))
  );

  return {
    symbol,
    source: 'binance.vision (proxy pentru istoric adânc)',
    parity: 'engine primește 5m+15m+60m, identic cu serverul live',
    days,
    totalCandles: tf5.length,
    neutralCount,
    evaluated: samples.length,
    cooldownBars: COOLDOWN,
    split: { trainFraction, trainN: train.length, testN: test.length },

    // ---- headline: out-of-sample only ----
    outOfSample: {
      all: rate(test),
      byInterval: byGroup(test, (s) => s.interval),
      bySetup: byGroup(test, (s) => s.setup),
      byDirection: byGroup(test, (s) => s.direction),
      byHour: byGroup(test, (s) => `h${String(s.hour).padStart(2, '0')}`),
    },

    // ---- does the horizon choice matter? both windows, same signals ----
    horizonComparison: {
      note: 'aceleași semnale evaluate la 10 vs 30 min, ca să se vadă care fereastră e mai bună per setup',
      at10: rate(test, 'win10'),
      at30: rate(test, 'win30'),
      bySetupAt10: byGroup(test, (s) => s.setup, 'win10'),
      bySetupAt30: byGroup(test, (s) => s.setup, 'win30'),
    },

    // ---- null baselines on the identical bars ----
    baselines: {
      note: 'dacă motorul nu bate clar aceste linii, nu are edge',
      alwaysUp: baseUp,
      alwaysDown: baseDown,
      coinFlip: 50,
    },

    // ---- probability quality ----
    calibration: {
      fittedOn: train.length,
      minSample: model.minSample,
      brierScore: cal.brierScore(scored),
      brierBaseline: 0.25,
      brierNote: '0.25 = ce obții spunând mereu 50%. Mai mic e mai bun.',
      reliability: cal.reliability(scored),
      coverage: {
        withProbability: scored.filter((s) => s.predReady).length,
        withoutProbability: scored.filter((s) => !s.predReady).length,
      },
    },

    // ---- the only number that matters for real money ----
    evGate: {
      note: 'doar semnalele pe care poarta EV le-ar fi aprobat (limita inferioară a intervalului de încredere peste pragul impus de payout)',
      payout10,
      payout30,
      breakEven10: cal.breakEvenWinRate(payout10),
      breakEven30: cal.breakEvenWinRate(payout30),
      approvedCount: approved.length,
      rejectedCount: scored.length - approved.length,
      approved: rate(approved),
      approvedByInterval: byGroup(approved, (s) => s.interval),
      realizedEv10: approved.filter((s) => s.interval === '10 minute').length
        ? cal.expectedValue(rate(approved.filter((s) => s.interval === '10 minute')).winRate, payout10)
        : null,
      realizedEv30: approved.filter((s) => s.interval === '30 minute').length
        ? cal.expectedValue(rate(approved.filter((s) => s.interval === '30 minute')).winRate, payout30)
        : null,
    },

    model,
    trades: scored.slice(0, 200).map((s) => ({
      time: s.time,
      directie: s.direction,
      interval: s.interval,
      setup: s.setup,
      score: s.score,
      probability: s.probability,
      approved: s.gate.trade,
      entry: s.entry,
      exit: s.interval === '10 minute' ? s.exit10 : s.exit30,
      win: s.win,
    })),
  };
}

module.exports = { run, WINDOW, HORIZON_10, HORIZON_30, COOLDOWN };
```


## `tools/selftest.js`

```javascript
'use strict';

// ============================================================================
// selftest.js — offline verification. Requires no network and no API keys.
//
//   node tools/selftest.js
//
// These are not unit tests of arithmetic; they are guards against the specific
// failure modes that made this app's output untrustworthy:
//
//   1. Repainting      — does a verdict change while a candle is still forming?
//   2. Horizon balance — do 10-minute signals actually occur?
//   3. Determinism     — same closed bars in, same verdict out?
//   4. Null edge       — on pure noise, does the EV gate correctly refuse?
//   5. Event maths     — break-even, EV and interval arithmetic.
//
// Test 4 is the important one. Any signal engine can be made to fire; the thing
// that protects money is refusing to fire when there is nothing there.
// ============================================================================

const engine = require('../lib/engine');
const candlesLib = require('../lib/candles');
const cal = require('../lib/calibration');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// ---- Deterministic synthetic market ---------------------------------------
let seed = 20260729;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function gauss() { return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()); }

const STEP_5M = 5 * 60000;
const T0 = 1700000000000;

function make5m(n, startPrice = 3000) {
  const out = [];
  let p = startPrice;
  let t = T0;
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = p * (1 + gauss() * 0.0012);
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * 0.0004);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * 0.0004);
    out.push({ openTime: t, open, high, low, close, volume: 100 * Math.exp(gauss() * 0.4), closeTime: t + STEP_5M - 1 });
    p = close;
    t += STEP_5M;
  }
  return out;
}

const SERIES = make5m(4200);
// Timeframes derived by aggregation so all views are mutually consistent.
const view = (upTo) => {
  const s5 = SERIES.slice(0, upTo);
  return {
    '5m': s5.slice(-200),
    '15m': candlesLib.aggregate(s5, 3).slice(-200),
    '60m': candlesLib.aggregate(s5, 12).slice(-200),
  };
};

// ===========================================================================
section('1. Repainting: verdicts must not move while a candle forms');

{
  // A closed history plus a candle that is still forming. We mutate the forming
  // candle through a full range of shapes — including one that manufactures a
  // textbook liquidity sweep — and assert the verdict never budges.
  const closed = SERIES.slice(0, 300);
  const lastClose = closed[closed.length - 1].close;
  const openTime = closed[closed.length - 1].closeTime + 1;
  const closeTime = openTime + STEP_5M - 1;
  const nowMidBar = openTime + Math.floor(STEP_5M / 2); // wall clock inside the bar

  const shapes = [
    { close: lastClose * 0.995, high: lastClose * 1.0005, low: lastClose * 0.9930, volume: 40 },
    { close: lastClose * 1.004, high: lastClose * 1.0060, low: lastClose * 0.9990, volume: 900 },
    { close: lastClose * 0.999, high: lastClose * 1.0010, low: lastClose * 0.9900, volume: 500 },
    { close: lastClose * 1.001, high: lastClose * 1.0020, low: lastClose * 0.9995, volume: 120 },
  ];

  const verdicts = shapes.map((s) => {
    const forming = { openTime, open: lastClose, high: s.high, low: s.low, close: s.close, volume: s.volume, closeTime };
    const raw = closed.concat([forming]);
    // This is the pipeline the live server now uses.
    const confirmed = candlesLib.closedOnly(raw, nowMidBar);
    const s5 = confirmed.slice(-200);
    return engine.decide({
      '5m': s5,
      '15m': candlesLib.aggregate(confirmed, 3).slice(-200),
      '60m': candlesLib.aggregate(confirmed, 12).slice(-200),
    });
  });

  const dirs = [...new Set(verdicts.map((v) => v.directie))];
  const nets = [...new Set(verdicts.map((v) => v.scores.net))];
  const bars = [...new Set(verdicts.map((v) => v.barCloseTime))];

  check('direction is stable across all forming-candle shapes', dirs.length === 1, `directions seen: ${dirs.join(', ')}`);
  check('score is stable across all forming-candle shapes', nets.length === 1, `nets seen: ${nets.join(', ')}`);
  check('verdict is attributed to the last CLOSED bar', bars.length === 1 && bars[0] < openTime,
    `barCloseTime=${bars[0]}, forming bar opened at ${openTime}`);

  // And the forming candle must genuinely be excluded.
  const withForming = closed.concat([{ openTime, open: lastClose, high: lastClose * 1.01, low: lastClose * 0.99, close: lastClose, volume: 999, closeTime }]);
  check('closedOnly() strips the unclosed candle',
    candlesLib.closedOnly(withForming, nowMidBar).length === closed.length,
    `${withForming.length} in -> ${candlesLib.closedOnly(withForming, nowMidBar).length} out`);
  check('closedOnly() keeps it once the bar has closed',
    candlesLib.closedOnly(withForming, closeTime + 1).length === closed.length + 1);
}

// ===========================================================================
section('2. Horizon balance: 10-minute signals must actually occur');

const signals = [];
for (let i = 260; i < SERIES.length - 6; i += 3) {
  const v = engine.decide(view(i));
  if (v.directie === 'NEUTRU') continue;
  const entry = SERIES[i - 1].close;
  const h = v.interval === '10 minute' ? 2 : 6;
  const exit = SERIES[i - 1 + h].close;
  signals.push({
    setup: v.setup,
    interval: v.interval,
    direction: v.directie,
    score: v.score,
    win: v.directie === 'UP' ? exit > entry : exit < entry,
  });
}

{
  const n10 = signals.filter((s) => s.interval === '10 minute').length;
  const n30 = signals.filter((s) => s.interval === '30 minute').length;
  const share10 = signals.length ? (n10 / signals.length) * 100 : 0;
  console.log(`  ${signals.length} signals: ${n10} x 10min (${share10.toFixed(1)}%), ${n30} x 30min`);
  check('both contract windows are produced', n10 > 0 && n30 > 0, `10min=${n10}, 30min=${n30}`);
  check('10-minute share is not vanishing (>5%)', share10 > 5, `${share10.toFixed(1)}%`);
  const setups = [...new Set(signals.map((s) => s.setup))];
  check('no signal is emitted without a real trigger', !setups.includes('context'), `setups: ${setups.join(', ')}`);
}

// ===========================================================================
section('3. Determinism: identical closed input yields identical output');

{
  const a = engine.decide(view(1500));
  const b = engine.decide(view(1500));
  const strip = (v) => JSON.stringify({ ...v, ts: 0 });
  check('decide() is a pure function of the candles', strip(a) === strip(b));
}

// ===========================================================================
section('4. Null edge: on pure noise the EV gate must refuse');

{
  const wins = signals.filter((s) => s.win).length;
  const wr = signals.length ? (wins / signals.length) * 100 : 0;
  const sig = cal.vsCoinFlip(wins, signals.length);
  console.log(`  raw win-rate on random walk: ${wr.toFixed(1)}% (${wins}/${signals.length}), z=${sig.z}, p=${sig.pValue}`);
  check('random-walk win-rate is near 50% (no look-ahead leak)', Math.abs(wr - 50) < 5, `${wr.toFixed(1)}%`);
  check('random-walk edge is NOT statistically significant', !sig.significant, `p=${sig.pValue}`);

  // Fit on the first half, gate the second half, at realistic payouts.
  const cut = Math.floor(signals.length / 2);
  const model = cal.fit(signals.slice(0, cut), { minSample: 30 });
  const held = signals.slice(cut);
  let approved = 0;
  for (const s of held) {
    const pred = cal.predict(model, s);
    const payout = s.interval === '10 minute' ? 65 : 82;
    if (cal.decide(pred, payout, { marginPct: 1.5 }).trade) approved++;
  }
  const approvedPct = held.length ? (approved / held.length) * 100 : 0;
  console.log(`  EV gate approved ${approved}/${held.length} (${approvedPct.toFixed(1)}%) of noise signals`);
  check('EV gate approves (almost) nothing on data with no edge', approvedPct < 5, `${approvedPct.toFixed(1)}% approved`);
}

// ===========================================================================
section('5. Event-futures arithmetic');

{
  // Break-even = 1/(1+payout).
  check('payout 65% needs 60.6%', Math.abs(cal.breakEvenWinRate(65) - 60.61) < 0.05, `${cal.breakEvenWinRate(65)}%`);
  check('payout 82% needs 54.9%', Math.abs(cal.breakEvenWinRate(82) - 54.95) < 0.05, `${cal.breakEvenWinRate(82)}%`);
  check('payout 100% needs 50%', Math.abs(cal.breakEvenWinRate(100) - 50) < 0.01);
  check('EV is zero exactly at break-even',
    Math.abs(cal.expectedValue(cal.breakEvenWinRate(65), 65)) < 0.05,
    `EV=${cal.expectedValue(cal.breakEvenWinRate(65), 65)}%`);
  check('EV is negative below break-even', cal.expectedValue(55, 65) < 0, `EV=${cal.expectedValue(55, 65)}%`);
  check('EV is positive above break-even', cal.expectedValue(65, 65) > 0, `EV=${cal.expectedValue(65, 65)}%`);

  // A small sample must never be treated as an edge, however good it looks.
  const tiny = cal.wilson(14, 25); // 56% off 25 samples
  check('56% off 25 samples has a lower bound below break-even', tiny.low < cal.breakEvenWinRate(82),
    `CI low ${tiny.low}% vs break-even ${cal.breakEvenWinRate(82)}%`);
  const gateTiny = cal.decide({ ready: true, probability: 56, ciLow: tiny.low, ciHigh: tiny.high, n: 25 }, 82);
  check('EV gate refuses that sample', !gateTiny.trade, gateTiny.reason);

  // Unknown probability must never be silently treated as tradeable.
  const gateBlind = cal.decide({ ready: false, source: 'no data' }, 82);
  check('EV gate refuses when probability is unknown', !gateBlind.trade && gateBlind.needsData === true);
}

// ===========================================================================
section('6. Position sizing: stake must scale with the MEASURED edge');

{
  const sizing = require('../lib/sizing');
  const gateFor = (p, n, payout = 82) => {
    const wins = Math.round((p * n) / 100);
    const ci = cal.wilson(wins, n);
    const ci90 = cal.wilson(wins, n, 1.2815516);
    return cal.decide({ ready: true, probability: p, ciLow: ci.low, ciHigh: ci.high, ciLow90: ci90.low, n }, payout);
  };

  const weak = sizing.recommend(gateFor(54, 300), 82, { bankroll: 1000 });
  const thin = sizing.recommend(gateFor(70, 12), 82, { bankroll: 1000 });
  const good = sizing.recommend(gateFor(63, 400), 82, { bankroll: 1000 });
  const huge = sizing.recommend(gateFor(85, 500), 82, { bankroll: 1000 });

  check('no stake when the edge does not clear break-even', weak.stake === 0, weak.reason);
  check('no stake on a great-looking but tiny sample', thin.stake === 0, `n=12 -> ${thin.stake}`);
  check('a real edge produces a stake', good.stake > 0, `${good.stake} (${good.pctOfBankroll}%) ${good.tierLabel}`);
  check('bigger edge produces a bigger stake', huge.pctOfBankroll >= good.pctOfBankroll,
    `${good.pctOfBankroll}% -> ${huge.pctOfBankroll}%`);
  check('stake never exceeds the hard cap', huge.pctOfBankroll <= 5, `${huge.pctOfBankroll}% cap 5%`);
  check('cap is enforced even at an absurd edge',
    sizing.recommend(gateFor(95, 2000), 82, { bankroll: 1000, maxStakePct: 3 }).pctOfBankroll <= 3);
  check('stake scales linearly with bankroll',
    Math.abs(sizing.recommend(gateFor(63, 400), 82, { bankroll: 2000 }).stake - good.stake * 2) < 0.05);
  check('sizing refuses when probability is unknown',
    sizing.recommend(cal.decide({ ready: false, source: 'x' }, 82), 82).stake === 0);
  // Thin samples must be discounted, not trusted equally.
  check('sample-size trust grows with n', sizing.sampleTrust(50, 200) < sizing.sampleTrust(200, 200),
    `${sizing.sampleTrust(50, 200).toFixed(2)} < ${sizing.sampleTrust(200, 200).toFixed(2)}`);
}

// ===========================================================================
section('7. Settlement: TWAP, not a single tick');

{
  const { PriceTape } = require('../lib/priceTape');
  const t0 = 1700000000000;

  // Price sits flat at 3000, then spikes to 3060 on the very last tick — the
  // classic case where a single-tick comparison and a TWAP disagree.
  const tape = new PriceTape();
  for (let i = 0; i < 30; i++) tape.push('ETHUSDT', i === 29 ? 3060 : 3000, t0 + i * 1000);

  const last = tape.latest('ETHUSDT').price;
  const twap = tape.twap('ETHUSDT', t0, t0 + 29000);
  check('a final spike moves the last tick', last === 3060, `last=${last}`);
  check('the same spike barely moves the TWAP', Math.abs(twap.price - 3000) < 1,
    `TWAP=${twap.price.toFixed(2)} vs tick=${last}`);
  check('TWAP reports its method and sample count', twap.method === 'twap' && twap.samples === 30);

  // An entry at 3010 would be scored a WIN for UP on the tick and a LOSS on the
  // TWAP. That divergence is exactly what made the old journal untrustworthy.
  const entry = 3010;
  check('tick and TWAP genuinely disagree on the outcome',
    (last > entry) !== (twap.price > entry),
    `UP from ${entry}: tick says ${last > entry ? 'WIN' : 'LOSS'}, TWAP says ${twap.price > entry ? 'WIN' : 'LOSS'}`);

  check('empty window yields no price rather than a guess',
    tape.twap('ETHUSDT', t0 - 100000, t0 - 90000) === null);
  check('unknown symbol yields no price', tape.twap('NOPE', t0, t0 + 1000) === null);

  // Uneven sampling: a burst of ticks must not outvote a long steady stretch.
  const t2 = new PriceTape();
  t2.push('X', 100, t0);
  for (let i = 0; i < 20; i++) t2.push('X', 200, t0 + 59000 + i * 10); // burst at the end
  const w = t2.twap('X', t0, t0 + 60000);
  check('time-weighting beats tick-counting', w.price < 150,
    `TWAP=${w.price.toFixed(1)} (a plain mean of ticks would be ~195)`);
}

// ===========================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
```


## `tools/doctor.js`

```javascript
'use strict';

// ============================================================================
// doctor.js — "why am I not seeing any signals?"
//
//   node tools/doctor.js
//   node tools/doctor.js ETHUSDT
//
// Runs the entire live pipeline once, printing what happened at every stage, in
// plain language. It answers, in order:
//
//   1. Can this machine even reach MEXC?
//   2. Is the candle data fresh, or stale/cached?
//   3. What does the engine actually see right now?
//   4. If there is no signal — WHICH filter blocked it, by name?
//
// Step 4 is the point. An app that silently shows nothing is indistinguishable
// from an app that is broken, and that ambiguity is a defect in itself.
// ============================================================================

const mexc = require('../lib/mexc');
const engine = require('../lib/engine');
const orderflow = require('../lib/orderflow');
const cal = require('../lib/calibration');
const sizing = require('../lib/sizing');
const candlesLib = require('../lib/candles');
const journal = require('../lib/journal');
const fs = require('fs');
const path = require('path');

const SYMBOL = (process.argv[2] || 'BTCUSDT').toUpperCase();
const line = (n = 72) => console.log('-'.repeat(n));

function loadConfig() {
  const p = path.join(__dirname, '..', 'config.json');
  const defaults = {
    payout10: 65, payout30: 82, evMarginPct: 1.5, calibrationMinSample: 30,
    bankroll: 1000, kellyFractionMultiplier: 0.25, maxStakePct: 5, minStakePct: 0.5,
    maxEntryDelaySec: 90, activeHoursUTC: [6, 7, 8, 9, 13, 14, 15, 16, 17],
    sniperMode: true, sniperRequireVolume: false, requireEvGate: true,
  };
  try {
    if (fs.existsSync(p)) return { ...defaults, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch { /* use defaults */ }
  return defaults;
}

function loadCalibration() {
  const p = path.join(__dirname, '..', 'calibration.json');
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* none */ }
  return null;
}

(async () => {
  const config = loadConfig();
  console.log(`\n  DIAGNOSTIC SIGNALPILOT — ${SYMBOL}`);
  console.log(`  ${new Date().toLocaleString('ro-RO')}   Node ${process.versions.node}`);
  line();

  // ---- 1. Connectivity ----------------------------------------------------
  console.log('\n[1] CONEXIUNE LA MEXC');
  const t0 = Date.now();
  try {
    const ok = await mexc.ping();
    console.log(`    ping          : ${ok ? 'OK' : 'a răspuns, dar nu cu succes'} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`    ping          : EȘUAT — ${e.message}`);
    console.log('\n    >>> Aplicația NU poate ajunge la MEXC. Fără date, nu există semnale.');
    console.log('    >>> Cauze uzuale: MEXC blocat de furnizorul de internet sau din regiune,');
    console.log('        firewall/antivirus, sau lipsă de conexiune. Încearcă un VPN sau alt internet.');
    console.log('    >>> Verifică direct în browser: https://api.mexc.com/api/v3/ping');
    console.log('        Dacă nici acolo nu răspunde, problema e de rețea, nu de aplicație.\n');
    process.exit(1);
  }

  let price = null;
  try {
    price = await mexc.fetchPrice(SYMBOL);
    console.log(`    preț live     : ${price}`);
  } catch (e) {
    console.log(`    preț live     : EȘUAT — ${e.message}`);
  }

  // ---- 2. Data freshness --------------------------------------------------
  console.log('\n[2] LUMÂNĂRI — sunt proaspete?');
  let mtf;
  try {
    mtf = await mexc.fetchMultiTimeframe(SYMBOL, ['5m', '15m', '60m'], 200);
  } catch (e) {
    console.log(`    EȘUAT — ${e.message}\n`);
    process.exit(1);
  }

  for (const tf of ['5m', '15m', '60m']) {
    const arr = mtf[tf] || [];
    if (!arr.length) { console.log(`    ${tf.padEnd(4)}: NIMIC primit`); continue; }
    const last = arr[arr.length - 1];
    const ageSec = Math.round((Date.now() - last.closeTime) / 1000);
    console.log(`    ${tf.padEnd(4)}: ${String(arr.length).padStart(3)} bare închise · ultima s-a închis acum ${ageSec}s · close ${last.close}`);
  }
  const forming = mtf.__forming && mtf.__forming['5m'];
  if (forming) {
    console.log(`    lumânarea în formare (exclusă din decizii, corect): close curent ${forming.close}`);
  }
  console.log('    NOTĂ: verdictul se schimbă o dată la 5 minute, la închiderea barei.');
  console.log('          Prețul se mișcă în continuu; DECIZIA nu. Asta e intenționat.');

  // ---- 3. What the engine sees -------------------------------------------
  console.log('\n[3] CE VEDE MOTORUL ACUM');
  const verdict = engine.decide(mtf);
  console.log(`    direcție      : ${verdict.directie}`);
  console.log(`    fereastră     : ${verdict.interval}`);
  console.log(`    setup         : ${verdict.setup}`);
  console.log(`    scor net      : ${verdict.scores.net}  (up ${verdict.scores.up} / down ${verdict.scores.down})`);
  console.log(`    confluență    : ${verdict.confluence} semnale`);
  if (verdict.signals.length) {
    console.log('    semnale active:');
    for (const s of verdict.signals) console.log(`                    • ${s.label} [${s.tf}] +${s.weight}`);
  } else {
    console.log('    semnale active: niciunul pe direcția câștigătoare');
  }

  try {
    const of = await orderflow.getOrderFlow(SYMBOL);
    console.log(`    order flow    : ${of.state} (presiune ${of.pressure}, delta ${of.delta}${of.deltaReliable ? '' : ' — NEFIABIL'})`);
  } catch (e) {
    console.log(`    order flow    : indisponibil (${e.message})`);
  }

  // ---- 4. Why is there no alert? -----------------------------------------
  console.log('\n[4] DE CE NU PRIMEȘTI ALERTĂ');
  const blockers = [];

  if (verdict.directie === 'NEUTRU') {
    blockers.push('Motorul e NEUTRU: nu există un declanșator valid pe nicio direcție. Asta e normal pe majoritatea barelor — pe date fără tipar clar, motorul stă deoparte ~60% din timp.');
  }

  const calModel = loadCalibration();
  const resolved = journal.all().filter((e) => e.status === 'resolved').length;
  console.log(`    calibrare salvată : ${calModel ? `DA — ${calModel.total} rezultate` : 'NU'}`);
  console.log(`    jurnal rezolvat   : ${resolved} rezultate`);

  if (verdict.directie !== 'NEUTRU') {
    let prediction = { ready: false, source: 'nicio calibrare' };
    if (calModel) {
      prediction = cal.predict(calModel, { setup: verdict.setup, interval: verdict.interval, score: verdict.score });
    }
    const payout = verdict.interval === '10 minute' ? config.payout10 : config.payout30;
    const gate = cal.decide(prediction, payout, { marginPct: config.evMarginPct });

    console.log(`    probabilitate     : ${prediction.ready ? prediction.probability + '%' : 'INDISPONIBILĂ'}`);
    console.log(`    prag necesar      : ${gate.breakEven}% (payout ${payout}%) + marjă ${config.evMarginPct} = ${gate.required || '?'}%`);

    if (!gate.trade) {
      if (gate.needsData) {
        blockers.push(`FĂRĂ CALIBRARE. Motorul vede ${verdict.directie} ${verdict.interval} (${verdict.setup}), dar nu are o probabilitate măsurată, deci poarta EV blochează alerta. ACȚIUNE: pornește aplicația și apasă "Calibrează pe ultimele 30 de zile". Sau, ca să vezi semnalele fără poartă, pune requireEvGate=false în config.json.`);
      } else {
        blockers.push(`EV nefavorabil: ${gate.reason}`);
      }
    } else {
      const sz = sizing.recommend(gate, payout, config);
      console.log(`    miză recomandată  : ${sz.stake} (${sz.pctOfBankroll}%) ${sz.tierLabel}`);
      if (sz.stake <= 0) blockers.push(`Edge prea mic pentru o miză minimă: ${sz.reason}`);
    }

    const hourUTC = new Date(verdict.barCloseTime).getUTCHours();
    const snip = engine.sniperEligibility(verdict, hourUTC, config.activeHoursUTC, config.sniperRequireVolume);
    console.log(`    ora UTC          : ${hourUTC} (ore active: ${config.activeHoursUTC.join(',')})`);
    if (config.sniperMode && !snip.eligible) {
      blockers.push(`Sniper Mode e ACTIV și cere setup A+: ${snip.reason}. ACȚIUNE: dezactivează Sniper Mode ca să primești și semnale bune-dar-nu-perfecte.`);
    }
  }

  line();
  if (!blockers.length) {
    console.log('\n  >>> Nimic nu blochează. Ar trebui să vezi alertă în interfață ACUM.\n');
  } else {
    console.log('\n  MOTIVELE, în ordine:\n');
    blockers.forEach((b, i) => console.log(`  ${i + 1}. ${b}\n`));
  }
})().catch((e) => {
  console.error('\n  Diagnostic eșuat:', e.message, '\n');
  process.exit(1);
});
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
        <div class="grid" style="margin-top:12px">
            <div class="field">
              <label>💰 Capital de tranzacționare (USDT)</label>
              <input type="number" id="bankroll" min="1" step="10" value="1000" />
              <label>Fracțiune Kelly (0.25 = un sfert)</label>
              <input type="number" id="kellyFractionMultiplier" min="0.05" max="1" step="0.05" value="0.25" />
              <small class="muted">Miza crește cu edge-ul măsurat. Se calculează din probabilitatea <b>prudentă</b>, nu din cea optimistă, apoi se înmulțește cu această fracțiune. Kelly integral maximizează creșterea doar dacă probabilitatea e exactă — nu e niciodată, iar supralicitarea duce la ruină. Un sfert de Kelly e practica standard.</small>
            </div>
            <div class="field">
              <label>Plafon absolut per poziție (% din capital)</label>
              <input type="number" id="maxStakePct" min="0.5" max="25" step="0.5" value="5" />
              <small class="muted">Un contract binar nu se poate închide în pierdere parțială — nu există stop-loss. Oricât ar sugera formula, miza nu trece peste acest plafon.</small>
              <label>Timp maxim de intrare după închiderea barei (secunde)</label>
              <input type="number" id="maxEntryDelaySec" min="10" max="600" step="10" value="90" />
              <small class="muted">Semnalul descrie bara care s-a închis. Intrarea 5 minute mai târziu e alt trade: orizont efectiv mai scurt și alt preț de intrare. După acest interval, semnalul expiră.</small>
            </div>
        </div>
        <div class="grid" style="margin-top:12px">
            <div class="field">
              <label class="switch-inline"><input type="checkbox" id="requireEvGate" checked /> <b>🚦 Poarta EV</b> — nu alerta decât dacă probabilitatea calibrată bate pragul impus de payout</label>
              <small class="muted">Pentru un contract binar, direcția nu e suficientă. Cu payout de 65% ai nevoie de 60.6% ca să fii pe zero; cu 82%, de 54.9%. Poarta compară <b>limita inferioară</b> a intervalului de încredere cu acest prag, nu estimarea optimistă — de asta refuză un 56% obținut din 25 de mostre.</small>
            </div>
            <div class="field">
              <label>Marjă cerută peste pragul de rentabilitate (%)</label>
              <input type="number" id="evMarginPct" min="0" max="15" step="0.5" value="1.5" />
              <label>Rezultate minime per tipar înainte să am încredere</label>
              <input type="number" id="calibrationMinSample" min="10" max="500" value="30" />
              <small class="muted">Mai mic = alertează mai repede, dar pe statistici mai fragile.</small>
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

    <!-- DIAGNOSTICS -->
    <section class="panel">
      <div class="panel-head">
        <h2>🩺 Diagnostic — de ce văd / nu văd semnale</h2>
        <button id="runDiagnose" class="btn-ghost">Verifică acum</button>
      </div>
      <div id="diagHeadline" class="diag-headline muted">apasă „Verifică acum"</div>
      <div id="diagBody"></div>
    </section>

    <!-- CALIBRATION -->
    <section class="panel">
      <div class="panel-head"><h2>🎚️ Calibrare (obligatorie înainte de primul semnal)</h2></div>
      <p class="muted" style="margin-top:-6px">
        Aplicația nu îți dă o probabilitate până nu o măsoară. Calibrarea rulează motorul pe istoric și învață, pentru fiecare setup și fereastră, în ce procent din cazuri a ieșit bine. Fără asta, banner-ul va spune <b>„FĂRĂ DATE — nu intra”</b>, ceea ce e comportamentul corect: un scor de confluență (ex. „net 6.19”) nu este o probabilitate.
      </p>
      <div class="backtest-controls">
        <button id="runCalibration" class="btn-primary">Calibrează pe ultimele 30 de zile</button>
        <span id="calStatus" class="muted"></span>
      </div>
    </section>

    <!-- BACKTEST -->
    <section class="panel">
      <div class="panel-head"><h2>Backtest (out-of-sample, cu baseline și marjă de eroare)</h2></div>
      <p class="muted" style="margin-top:-6px">
        Calibrarea se face pe o felie mai veche, iar scorul se dă pe una mai nouă, neatinsă. Se raportează și ce a obținut „mereu UP” pe exact aceleași bare, plus un test statistic față de o monedă aruncată. Dacă motorul nu bate clar aceste repere, nu are edge — indiferent cât de bine arată win-rate-ul general.
      </p>
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

  // The BIG banner. For a binary contract, direction alone is not a reason to
  // trade — the calibrated probability has to beat the break-even the payout
  // imposes. So the banner is driven by the EV gate, and when there is no
  // calibration data it says exactly that instead of showing a green light.
  const ev = v.ev;
  const gate = v.gate;
  const payoutNow = ev ? (v.interval === '10 minute' ? ev.payout10 : ev.payout30) : null;
  const beNow = gate ? gate.breakEven : null;
  const probTxt = gate && gate.probability != null
    ? `${gate.probability}% (prudent ${gate.conservative}%)`
    : 'necalibrat';
  const evNote = ev
    ? ` · payout ${payoutNow}% → nevoie ${beNow}% · probabilitate ${probTxt}`
    : '';

  const gateOk = !!(gate && gate.trade);
  const needsData = !!(gate && gate.needsData);
  const sz = v.sizing;
  const hasStake = !!(sz && sz.stake > 0);
  const tradeable = gateOk && hasStake && (!SNIPER_MODE || eligible);

  // Stake block: the emphasis a trader actually needs — how much, and how much
  // time is left to act on a signal computed at the last bar close.
  const stakeBlock = hasStake ? `
    <div class="stake-row tier-${sz.tier}">
      <div class="stake-main">
        <span class="stake-tier">${sz.tierLabel}</span>
        <span class="stake-amt">${fmt(sz.stake)} <span class="muted">USDT</span></span>
        <span class="stake-pct">${sz.pctOfBankroll}% din ${fmt(sz.bankroll)}</span>
      </div>
      <div class="stake-note muted">edge <b>${sz.edgePct}</b> puncte peste pragul de rentabilitate · Kelly integral ${sz.kellyFull}% → folosit ${sz.kellyUsed}% · încredere statistică ${(sz.trust * 100).toFixed(0)}% (${gate.n} rezultate)</div>
      ${(sz.warnings || []).map((w) => `<div class="stake-warn">⚠️ ${w}</div>`).join('')}
    </div>` : '';

  const ew = v.entryWindow;
  const countdown = ew && !ew.stale
    ? `<div class="entry-window" data-deadline="${ew.deadlineTs}">⏱ timp de intrare: <b>${Math.max(0, ew.secondsLeft)}s</b> <span class="muted">(bara s-a închis la ${new Date(ew.barCloseTime).toLocaleTimeString('ro-RO')})</span></div>`
    : '';

  let banner;
  if (v.directie === 'NEUTRU') {
    banner = `<div class="cta wait">⏳ AȘTEAPTĂ<div class="cta-sub">fără declanșator valid — nicio poziție</div></div>`;
  } else if (v.observation) {
    // The engine found a setup but has no measured probability yet. Shown so the
    // work is visible, never dressed up as a recommendation.
    banner = `<div class="cta observe ${dir}">👁 OBSERVARE: ${v.directie} ${v.directie === 'UP' ? '▲' : '▼'} · ${v.interval}
      <div class="cta-sub">${v.setup} — motorul vede setup-ul, dar <b>încă nu are o probabilitate măsurată</b>, deci NU e recomandare de intrare.</div></div>
      <div class="observe-note">Semnalul intră în jurnal și se rezolvă automat după ${v.interval}. Pe măsură ce se adună rezultate, aplicația învață cât valorează acest setup și începe să dea recomandări reale cu miză. Ca să sari peste așteptare, rulează <b>Calibrarea</b> pe istoric.</div>`;
  } else if (tradeable) {
    banner = `<div class="cta go ${dir}">${SNIPER_MODE ? '🎯 ' : ''}INTRĂ ${v.directie} ${v.directie === 'UP' ? '▲' : '▼'}<div class="cta-sub">MEXC event futures · fereastră ${v.interval}${evNote}</div></div>${stakeBlock}${countdown}`;
  } else if (needsData) {
    banner = `<div class="cta wait">📊 FĂRĂ DATE — nu intra<div class="cta-sub">motorul vede ${v.directie} ${v.interval} (${v.setup}), dar nu are încă o probabilitate verificată. Rulează calibrarea sau lasă jurnalul să adune rezultate.</div></div>`;
  } else if (!gateOk) {
    banner = `<div class="cta wait">🚫 EV NEGATIV — sari peste<div class="cta-sub">${gate ? gate.reason : 'EV nefavorabil'}</div></div>`;
  } else if (ew && ew.stale) {
    banner = `<div class="cta wait">⌛ SEMNAL EXPIRAT<div class="cta-sub">bara s-a închis acum peste ${ew.maxEntryDelaySec}s — intrarea acum ar fi alt trade (orizont mai scurt, alt preț). Aștepți bara următoare.</div></div>`;
  } else if (!hasStake) {
    banner = `<div class="cta wait">🔍 EDGE PREA MIC<div class="cta-sub">${sz ? sz.reason : 'nu justifică o miză minimă'}</div></div>`;
  } else {
    banner = `<div class="cta wait">⏳ AȘTEAPTĂ<div class="cta-sub">nu e setup A+: ${v.sniper ? v.sniper.reason : '—'}</div></div>`;
  }
  const warnLine = '';

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
        <b>Declanșator</b><span>${v.setup || '—'}${v.primaryTrigger ? ` <span class="muted">(${v.primaryTrigger.label} [${v.primaryTrigger.tf}])</span>` : ''}</span>
        <b>Scor confluență</b><span><span class="pill ${v.incredere}">${v.incredere}</span> <span class="muted">(net ${v.scores.net} — scor brut, NU o probabilitate)</span></span>
        <b>Justificare</b><span>${v.justificare}</span>
        <b>Invalidare</b><span>${v.invalidare}</span>
        ${ev ? `
        <b>Probabilitate</b><span>${gate && gate.probability != null
          ? `<b>${gate.probability}%</b> · limita inferioară de încredere <b>${gate.conservative}%</b> <span class="muted">(din ${gate.n} rezultate — ${ev.probabilitySource || gate.source})</span>`
          : `<span class="bad">indisponibilă</span> <span class="muted">${gate ? gate.reason : ''}</span>`}</span>
        <b>Prag de rentabilitate</b><span>payout ${payoutNow}% ⇒ ai nevoie de <b>${beNow}%</b> doar ca să fii pe zero${gate && gate.required != null ? ` · prag cerut cu marjă: <b>${gate.required}%</b>` : ''}</span>
        <b>EV</b><span>${gate && gate.ev != null
          ? `<span class="${gate.ev > 0 ? 'dir-inline up' : 'dir-inline down'}">${gate.ev > 0 ? '+' : ''}${gate.ev}%</span> per miză${gate.evConservative != null ? ` <span class="muted">(prudent ${gate.evConservative}%)</span>` : ''}`
          : '<span class="muted">necalculabil fără probabilitate</span>'}</span>
        <b>Cealaltă fereastră</b><span>${ev.alternative ? `${ev.alternative.interval}: ${ev.alternative.probability != null ? ev.alternative.probability + '%' : 'necalibrat'}${ev.alternative.ev != null ? ` · EV ${ev.alternative.ev > 0 ? '+' : ''}${ev.alternative.ev}%` : ''} ${ev.alternative.trade ? '<span class="ok">(ar trece)</span>' : '<span class="muted">(nu trece)</span>'}` : '—'}</span>
        <b>Bara analizată</b><span class="muted">${v.barCloseTime ? 'închisă la ' + new Date(v.barCloseTime).toLocaleTimeString('ro-RO') : '—'} · doar lumânări confirmate</span>` : ''}
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
  $('requireEvGate').checked = c.requireEvGate !== false;
  if (c.evMarginPct != null) $('evMarginPct').value = c.evMarginPct;
  if (c.calibrationMinSample != null) $('calibrationMinSample').value = c.calibrationMinSample;
  if (c.bankroll != null) $('bankroll').value = c.bankroll;
  if (c.kellyFractionMultiplier != null) $('kellyFractionMultiplier').value = c.kellyFractionMultiplier;
  if (c.maxStakePct != null) $('maxStakePct').value = c.maxStakePct;
  if (c.maxEntryDelaySec != null) $('maxEntryDelaySec').value = c.maxEntryDelaySec;
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
    requireEvGate: $('requireEvGate').checked,
    evMarginPct: Number($('evMarginPct').value),
    calibrationMinSample: Number($('calibrationMinSample').value),
    bankroll: Number($('bankroll').value),
    kellyFractionMultiplier: Number($('kellyFractionMultiplier').value),
    maxStakePct: Number($('maxStakePct').value),
    maxEntryDelaySec: Number($('maxEntryDelaySec').value),
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
// The backtest report is deliberately built around three questions, in order:
//   1. Did it beat a coin flip out-of-sample, with error bars?
//   2. Did it beat "always bet UP" on the very same bars?
//   3. Of the trades the EV gate approved, was EV actually positive?
// A single headline win-rate hides all three, which is how a losing strategy
// ends up looking profitable.
async function runBacktest() {
  const symbol = $('btSymbol').value;
  const days = $('btDays').value;
  $('btStatus').textContent = 'rulez pe istoric (train/test separat)... poate dura zeci de secunde';
  $('btResult').innerHTML = '';
  try {
    const r = await fetch(`/api/backtest?symbol=${symbol}&days=${days}`);
    const d = await r.json();
    if (d.error) { $('btStatus').textContent = 'eroare: ' + d.error; return; }

    $('btStatus').innerHTML = `${d.evaluated} semnale (${d.neutralCount} bare fără semnal) pe ${d.totalCandles} lumânări · ` +
      `calibrat pe ${d.split.trainN}, testat pe ${d.split.testN} <b>neatinse</b> · ${d.parity}`;

    const box = (big, lbl, cls) => `<div class="bt-box"><div class="big ${cls || ''}">${big ?? '—'}</div><div class="lbl">${lbl}</div></div>`;
    const pct = (o) => (o && o.winRate != null ? o.winRate + '%' : '—');
    const ciTxt = (o) => (o && o.ci95 ? `95% CI ${o.ci95[0]}–${o.ci95[1]}%` : '');

    const oos = d.outOfSample.all;
    const sig = oos.vsCoinFlip || {};
    const verdictCls = sig.significant && oos.winRate > 50 ? 'ok' : 'bad';

    let html = '';
    html += box(pct(oos), `out-of-sample (${oos.n} semnale) · ${ciTxt(oos)}`, verdictCls);
    html += box(sig.pValue != null ? 'p=' + sig.pValue : '—',
      sig.significant ? 'DIFERIT de o monedă aruncată' : 'NU se distinge de noroc', verdictCls);
    html += box(pct(d.baselines.alwaysUp), 'baseline: mereu UP');
    html += box(pct(d.baselines.alwaysDown), 'baseline: mereu DOWN');

    for (const [iv, o] of Object.entries(d.outOfSample.byInterval || {})) {
      html += box(pct(o), `fereastră ${iv} (${o.n})`);
    }

    const g = d.evGate;
    html += box(`${g.approvedCount}/${g.approvedCount + g.rejectedCount}`, 'aprobate de poarta EV');
    if (g.approved && g.approved.n) {
      html += box(pct(g.approved), `win-rate pe cele aprobate (${g.approved.n}) · ${ciTxt(g.approved)}`);
      if (g.realizedEv10 != null) html += box(`${g.realizedEv10 > 0 ? '+' : ''}${g.realizedEv10}%`, `EV realizat 10 min (payout ${g.payout10}%)`, g.realizedEv10 > 0 ? 'ok' : 'bad');
      if (g.realizedEv30 != null) html += box(`${g.realizedEv30 > 0 ? '+' : ''}${g.realizedEv30}%`, `EV realizat 30 min (payout ${g.payout30}%)`, g.realizedEv30 > 0 ? 'ok' : 'bad');
    }
    html += box(g.breakEven10 + '%', `prag rentabilitate 10 min (payout ${g.payout10}%)`);
    html += box(g.breakEven30 + '%', `prag rentabilitate 30 min (payout ${g.payout30}%)`);

    const c = d.calibration;
    html += box(c.brierScore != null ? c.brierScore : '—',
      `Brier (${c.brierBaseline} = a spune mereu 50%)`,
      c.brierScore != null && c.brierScore < c.brierBaseline ? 'ok' : 'bad');

    $('btResult').innerHTML = html;

    // Per-setup and per-horizon detail, plus the reliability table.
    const rows = (obj) => Object.entries(obj || {})
      .map(([k, o]) => `<div class="lrow"><span>${k}</span><span>${pct(o)} <span class="muted">(${o.n})</span></span></div>`)
      .join('') || '<p class="muted">—</p>';

    const rel = (c.reliability || [])
      .filter((b) => b.n > 0)
      .map((b) => `<div class="lrow"><span>prezis ${b.range}</span><span>real <b>${b.actual}%</b> <span class="muted">(${b.n})</span></span></div>`)
      .join('') || '<p class="muted">încă nu sunt destule predicții pe intervale</p>';

    const detail = document.createElement('details');
    detail.className = 'analysis';
    detail.innerHTML = `<summary>Detaliu: per setup, per fereastră, calibrare</summary>
      <div class="learn-cols">
        <div><div class="learn-h">Per setup (out-of-sample)</div>${rows(d.outOfSample.bySetup)}</div>
        <div><div class="learn-h">Per oră UTC</div>${rows(d.outOfSample.byHour)}</div>
      </div>
      <div class="learn-cols" style="margin-top:12px">
        <div><div class="learn-h">Aceleași semnale la 10 min</div>${rows(d.horizonComparison.bySetupAt10)}</div>
        <div><div class="learn-h">Aceleași semnale la 30 min</div>${rows(d.horizonComparison.bySetupAt30)}</div>
      </div>
      <div style="margin-top:12px"><div class="learn-h">Calibrare: "X%" se întâmplă chiar în X% din cazuri?</div>${rel}</div>`;
    $('btResult').appendChild(detail);
  } catch (e) {
    $('btStatus').textContent = 'eroare: ' + e.message;
  }
}

// Diagnostics: make the app explain its own silence. Shows whether data is
// arriving, what the engine decided per bar, and which filter blocked each one.
async function runDiagnose() {
  $('diagHeadline').textContent = 'verific...';
  try {
    const d = await (await fetch('/api/diagnose')).json();

    const cls = d.fetchErrors > 0 && d.scans === 0 ? 'bad' : (d.calibration || d.journal.resolved >= d.journal.needed) ? 'ok' : 'warn';
    $('diagHeadline').className = `diag-headline ${cls}`;
    $('diagHeadline').innerHTML = `<b>${d.headline}</b>${d.action ? `<div class="diag-action">→ ${d.action}</div>` : ''}`;

    const box = (big, lbl, c) => `<div class="bt-box"><div class="big ${c || ''}">${big}</div><div class="lbl">${lbl}</div></div>`;
    let html = '<div class="bt-result">';
    html += box(d.scans, 'scanări reușite', d.scans > 0 ? 'ok' : 'bad');
    html += box(d.fetchErrors, 'erori de rețea', d.fetchErrors > 0 ? 'bad' : 'ok');
    html += box(`${d.verdicts.UP}/${d.verdicts.DOWN}`, 'bare UP / DOWN');
    html += box(d.verdicts.NEUTRU, 'bare neutre');
    html += box(d.alertsFired, 'alerte reale', d.alertsFired > 0 ? 'ok' : '');
    html += box(d.observations, 'semnale de observare');
    html += box(`${d.journal.resolved}/${d.journal.needed}`, 'rezultate strânse pentru calibrare');
    html += box(d.journal.pending, 'în așteptare de rezolvare');
    html += '</div>';

    if (d.lastFetchError) {
      html += `<div class="diag-err">Ultima eroare de rețea: <b>${d.lastFetchError.symbol}</b> — ${d.lastFetchError.message}
        <div class="muted">Dacă apare constant, MEXC e probabil blocat de furnizorul tău de internet. Testează https://api.mexc.com/api/v3/ping în browser.</div></div>`;
    }

    if (d.blockedBy && d.blockedBy.length) {
      html += '<div class="learn-h" style="margin-top:14px">Ce a blocat semnalele, în ordine de frecvență</div>';
      html += d.blockedBy.map((b) => `<div class="lrow"><span>${b.reason}</span><span><b>${b.count}</b> bare</span></div>`).join('');
    }

    if (d.recentBars && d.recentBars.length) {
      html += '<div class="learn-h" style="margin-top:14px">Ultimele bare analizate</div>';
      html += d.recentBars.slice(0, 15).map((b) => {
        const t = b.barCloseTime ? new Date(b.barCloseTime).toLocaleTimeString('ro-RO') : '—';
        const badge = b.alerted
          ? (b.observation ? '<span class="pill Mediu">observare</span>' : '<span class="pill Ridicat">ALERTĂ</span>')
          : '<span class="muted">blocat</span>';
        return `<div class="lrow"><span>${t} · ${b.symbol} · <b>${b.directie}</b> ${b.setup !== 'context' ? b.setup : ''}</span><span>${badge}</span></div>`;
      }).join('');
    }

    $('diagBody').innerHTML = html;
  } catch (e) {
    $('diagHeadline').className = 'diag-headline bad';
    $('diagHeadline').textContent = 'diagnostic eșuat: ' + e.message;
  }
}

// Fit the probability model from historical data and persist it, so the app has
// calibrated probabilities before the user's own journal is large enough.
async function runCalibration() {
  const days = 30;
  $('calStatus').textContent = 'calibrez pe istoric... poate dura un minut';
  try {
    const r = await fetch('/api/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    const d = await r.json();
    if (d.error) { $('calStatus').textContent = 'eroare: ' + d.error; return; }
    $('calStatus').innerHTML = `✓ calibrat pe ${d.model.total} rezultate (${days} zile). ` +
      `Buckets cu minim ${d.model.minSample} mostre sunt folosite live.`;
  } catch (e) {
    $('calStatus').textContent = 'eroare: ' + e.message;
  }
}

// ---------- wire up ----------
$('toggleSettings').addEventListener('click', () => $('settingsBody').classList.toggle('open'));
$('saveSettings').addEventListener('click', saveSettings);
$('testAi').addEventListener('click', testAi);
$('runBacktest').addEventListener('click', runBacktest);
$('runCalibration').addEventListener('click', runCalibration);
$('runDiagnose').addEventListener('click', runDiagnose);
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

// Live countdown on the entry window. Ticks locally so the remaining time is
// accurate between server pushes — a signal computed at bar close is only
// actionable for a limited number of seconds.
function tickCountdowns() {
  document.querySelectorAll('.entry-window[data-deadline]').forEach((el) => {
    const left = Math.round((Number(el.dataset.deadline) - Date.now()) / 1000);
    const b = el.querySelector('b');
    if (!b) return;
    if (left <= 0) {
      el.classList.add('expired');
      b.textContent = 'expirat';
    } else {
      b.textContent = left + 's';
      if (left <= 20) el.classList.add('urgent');
    }
  });
}

loadState();
connect();
updateSessionBadge();
setInterval(updateSessionBadge, 60000);
setInterval(tickCountdowns, 1000);
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


/* ---- Position sizing block -------------------------------------------------
   The stake is the second thing a trader reads after the direction, so it gets
   real visual weight. Tiers are colour-coded by how large the MEASURED edge is,
   never by how "confident" the signal feels. */
.stake-row {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid #2a3550;
  background: #141b2d;
}
.stake-main {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.stake-tier {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 3px 9px;
  border-radius: 999px;
  background: #2a3550;
  color: #cfe0ff;
}
.stake-amt { font-size: 26px; font-weight: 700; color: #eaf2ff; }
.stake-pct { font-size: 13px; color: #8fa3c8; }
.stake-note { margin-top: 6px; font-size: 11px; line-height: 1.5; }
.stake-warn {
  margin-top: 6px;
  font-size: 11px;
  color: #ffca7a;
  line-height: 1.5;
}

.stake-row.tier-maxima { border-color: #2f9e6b; background: #10241c; }
.stake-row.tier-maxima .stake-tier { background: #2f9e6b; color: #f2fff8; }
.stake-row.tier-mare   { border-color: #2d7d5a; background: #11201b; }
.stake-row.tier-mare .stake-tier { background: #2d7d5a; color: #f2fff8; }
.stake-row.tier-medie  { border-color: #7a6a2e; background: #1e1c12; }
.stake-row.tier-medie .stake-tier { background: #7a6a2e; color: #fff8e6; }
.stake-row.tier-mica   { border-color: #4a5570; }

/* ---- Entry window countdown ---------------------------------------------- */
.entry-window {
  margin-top: 8px;
  padding: 7px 12px;
  border-radius: 8px;
  background: #14203a;
  border: 1px solid #2a3550;
  font-size: 12px;
  color: #b9cbe8;
}
.entry-window b { color: #eaf2ff; font-variant-numeric: tabular-nums; }
.entry-window.urgent { border-color: #a35a2a; background: #251809; }
.entry-window.urgent b { color: #ffb066; }
.entry-window.expired { opacity: 0.55; }
.entry-window.expired b { color: #ff8b8b; }


/* ---- Observation mode ------------------------------------------------------
   The engine found a setup but has no measured probability yet. Visually this
   must NOT look like a green light — it is information, not a recommendation. */
.cta.observe {
  background: #1a2138;
  border: 1px dashed #5a6a92;
  color: #cfe0ff;
}
.cta.observe.up { border-color: #3d7a5f; }
.cta.observe.down { border-color: #8a4a4a; }
.observe-note {
  margin-top: 8px;
  padding: 9px 12px;
  border-radius: 8px;
  background: #141b2d;
  border: 1px solid #2a3550;
  font-size: 11px;
  line-height: 1.6;
  color: #8fa3c8;
}
.observe-note b { color: #cfe0ff; }

/* ---- Diagnostics panel ---------------------------------------------------- */
.diag-headline {
  padding: 11px 14px;
  border-radius: 9px;
  background: #141b2d;
  border: 1px solid #2a3550;
  font-size: 13px;
  line-height: 1.55;
}
.diag-headline.ok { border-color: #2d7d5a; background: #11201b; }
.diag-headline.warn { border-color: #7a6a2e; background: #1e1c12; }
.diag-headline.bad { border-color: #8a4a4a; background: #221314; }
.diag-action {
  margin-top: 6px;
  font-size: 12px;
  color: #b9cbe8;
  font-weight: 400;
}
.diag-err {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #221314;
  border: 1px solid #8a4a4a;
  font-size: 12px;
  line-height: 1.55;
}
.diag-err .muted { margin-top: 5px; font-size: 11px; }
```


## `README.md`

```markdown
# SignalPilot

Aplicație locală care citește date live de pe MEXC, calculează indicatori tehnici + concepte Smart Money **determinist**, și produce decizii **UP/DOWN** pentru contracte event-futures pe **10 / 30 minute**.

Ce o deosebește de un indicator obișnuit: nu îți dă doar o direcție, ci o **probabilitate măsurată** și o compară cu pragul de rentabilitate impus de payout. Dacă probabilitatea nu bate pragul, îți spune să nu intri.

---

## ⚠️ Citește asta întâi: ce s-a schimbat și de ce nu mai există cifre promise

O versiune anterioară a acestui README raporta rezultate de backtest de tipul „ETH Sniper 54.8% in-sample / 55.6% out-of-sample”. **Aceste cifre au fost retrase.** Nu erau reale, din trei motive măsurate în cod:

1. **Backtest-ul testa altă strategie decât cea care rula live.** Serverul trimitea motorului trei timeframe-uri (`5m`, `15m`, `60m`), iar backtest-ul doar două (`5m`, `15m`). Semnalul de aliniere cu trendul de 1h (pondere 1.5) exista live, dar nu în validare. Pe date identice, cele două puteau returna verdicte diferite — verificat: unul dădea `NEUTRU`, celălalt `UP`.

2. **Motorul citea lumânarea în formare** (*repainting*). Ultimul rând returnat de MEXC este lumânarea curentă, incompletă. Detectorii de sweep, spike de volum și raport de wick o citeau, deci verdictul se schimba în timpul barei. Măsurat pe aceeași bară de 5 minute: la 25% formată → `DOWN`, la 50% → `DOWN`, la 75% → `UP` **și alertă Sniper declanșată**, la închidere → `UP`. Alerta pleca pe date neconfirmate, care se puteau încă anula. Backtest-ul, care rula doar pe bare închise, nu vedea niciodată aceste oscilații.

3. **Nu exista separare train/test.** Win-rate-ul se raporta pe tot eșantionul, apoi se alegea cel mai bun subset („sweep + volum + ore active”) din exact aceleași numere care erau apoi citate ca dovadă. Asta e selectarea ipotezei pe datele folosite ca argument pentru ea.

Pe lângă acestea, două defecte de logică distorsionau puternic semnalele:

4. **Semnalele de 10 minute practic nu apăreau.** Fereastra se alegea comparând greutatea *însumată* a semnalelor „rapide” cu cea a semnalelor „structurale”. Contextul (trend, EMA, VWAP, aliniere 1h) e prezent aproape pe fiecare bară, iar declanșatorii rapizi sunt evenimente rare — deci structura câștiga aproape mereu. Măsurat pe 4000 de bare: **97.6% dintre semnale ieșeau pe 30 de minute, 2.4% pe 10.** README-ul promitea că „apar ambele”.

5. **FVG-urile se comportau ca zgomot, nu ca declanșatori.** Detectorul prindea orice imbalance mecanic de 3 lumânări, fără cerința de *displacement*, nu marca niciodată un gap ca mitigat, iar orice gap străpuns rămânea „Inversion FVG” tradeable pe termen nelimitat. Rezultat: prețul se afla în interiorul unui gap „valid” în 76% din bare, iar FVG + IFVG produceau **93% din toți declanșatorii**, acoperind complet celelalte setup-uri.

Toate cinci sunt reparate. Verificarea rulează offline, fără rețea:

```bash
node tools/selftest.js
```

### Ce au schimbat reparațiile (măsurat pe același random walk de 4200 de bare)

| | înainte | după |
|---|---|---|
| Semnale pe fereastra de 10 min | 2.4% | **20.1%** |
| Bare fără semnal (`NEUTRU`) | 14.4% | **59.8%** |
| Cel mai dominant setup | FVG+IFVG 93% | **max 22%** (RSI divergence) |
| Verdict stabil în timpul barei | nu | **da** |
| Semnale aprobate pe zgomot pur | — | **0 din 264** |

Ultimul rând e cel mai important. Pe date generate aleatoriu, unde prin construcție **nu există** niciun edge, poarta EV nu aprobă nimic. Orice motor poate fi făcut să dea semnale; ce protejează banii e să refuze când nu e nimic acolo.

---

## 🚦 Cum decide dacă merită intrat (partea specifică event futures)

Un contract binar nu te plătește pentru că ai ghicit direcția, ci pentru că ai ghicit **mai des decât cere payout-ul**. Cu payout `p`, o miză de 1 aduce `+p` la câștig și `-1` la pierdere:

```
EV = w·p − (1−w)          w = probabilitatea reală de câștig
```

EV devine pozitiv doar când `w > 1/(1+p)`. Pragul e brutal:

| Payout | Win-rate necesar doar ca să fii pe zero |
|---|---|
| 40% | 71.4% |
| 65% | 60.6% |
| 80% | 55.6% |
| 85% | 54.1% |

De aici decurg două reguli pe care aplicația le respectă strict:

**1. Un scor de confluență nu este o probabilitate.** „net 6.19” nu înseamnă nimic în termeni de șanse. Aplicația nu convertește scorul în procent printr-o formulă inventată; îl folosește doar ca etichetă de bucket și **măsoară** empiric în ce procent din cazuri fiecare bucket a ieșit bine (`lib/calibration.js`).

**2. Se compară limita inferioară, nu estimarea optimistă.** Poarta EV folosește capătul de jos al intervalului de încredere Wilson. Un 56% obținut din 25 de mostre are limita inferioară la ~37% — nu e edge, e zgomot, și poarta îl refuză. E lent la „da” în mod deliberat: alternativa e să pierzi bani.

Dacă nu există calibrare cu suficiente date, banner-ul spune **„FĂRĂ DATE — nu intra”**. Nu inventează un număr. (Versiunea anterioară presupunea un win-rate de 55% prin `fallbackWinRate` și afișa un EV calculat din această presupunere — a fost eliminat.)

---

## 💰 Cât să pui: miza vine din edge-ul măsurat

Când probabilitatea prudentă depășește pragul, aplicația calculează și **cât** merită pus, cu evidențiere pe nivele: `MICĂ` / `MEDIE` / `MARE` / `MAXIMĂ`. Nivelul e determinat de mărimea edge-ului în puncte peste pragul de rentabilitate — nu de cât de „sigur" arată semnalul.

Formula e Kelly pentru un payout binar `b`: `f* = (p·(1+b) − 1) / b`. Trei lucruri se aplică înainte ca vreo cifră să ajungă pe ecran:

1. **Se folosește probabilitatea prudentă**, limita inferioară a intervalului, nu estimarea punctuală. Kelly e extrem de sensibil la supraestimarea lui `p`: supralicitarea se compune spre ruină, în timp ce sublicitarea costă doar puțin randament.
2. **Se înmulțește cu o fracțiune** (implicit 0.25). Un sfert până la jumătate de Kelly e practica standard exact pentru că `p` real nu se cunoaște niciodată exact.
3. **Se plafonează dur** ca procent din capital (implicit 5%), indiferent ce sugerează formula. Un contract binar nu poate fi închis parțial — nu există stop-loss, poziția e totul sau nimic pe miza respectivă.

Consecința: „miză MAXIMĂ" înseamnă aici ~5% din capital, nu 50%. Exemple reale din motor, la payout 82% (prag 54.95%, cerut cu marjă 56.45%):

| Win-rate observat | Mostre | Probabilitate prudentă | Decizie | Miză |
|---|---|---|---|---|
| 54% | 300 | 50.3% | respins | 0 |
| 56% | 40 | 44.9% | respins | 0 |
| 58% | 120 | 52.5% | respins | 0 |
| 63% | 400 | 59.9% | **aprobat** | 2.73% — MARE |
| 70% | 500 | 67.3% | **aprobat** | 5% — MAXIMĂ |

Observă rândul cu 56% din 40 de mostre: arată tentant, dar limita inferioară e 44.9%. Aplicația refuză. Un instrument care ar recomanda o miză acolo te-ar costa bani.

## ⏱ Sincronizarea cu contractul

Două lucruri au fost nealiniate cu realitatea platformei și sunt reparate.

**Fereastra de intrare.** Verdictul descrie bara care s-a **închis**. Intrarea 6 minute mai târziu e un alt trade: orizontul efectiv e mai scurt și prețul de intrare s-a mutat. Semnalele expiră după `maxEntryDelaySec` (implicit 90s), cu numărătoare inversă în interfață. Un semnal expirat nu produce alertă.

**Prețul de decontare.** MEXC stabilește prețurile de decontare pentru predicțiile Up/Down folosind un **indice compozit în timp real combinat cu un preț mediu ponderat în timp (TWAP)** — vezi [anunțul oficial MEXC](https://blog.mexc.com/press-release/mexc-launches-up-or-down-prediction-feature/).

Jurnalul compara însă un singur tick de pe `/ticker/price` cu prețul de intrare. Aplicația se nota după alt barem decât cel după care plătește contractul, iar diferența nu e cosmetică: un wick în ultimele secunde răstoarnă o comparație pe un singur tick, dar aproape nu mișcă un TWAP. Test din suită:

```
preț plat la 3000, spike la 3060 pe ultimul tick, intrare la 3010, direcție UP
  un singur tick -> WIN
  TWAP pe 30s    -> LOSS
```

Se înregistrau câștiguri pe care contractul le-ar fi decontat ca pierderi, și invers. Acum decontarea folosește un TWAP pe ultimele `settlementTwapSec` (implicit 30s), din o bandă de prețuri eșantionată la fiecare 3 secunde, independent de bucla de scanare. Metoda folosită se salvează în fiecare intrare de jurnal, ca să nu se amestece tacit cu un fallback.

**Limitare declarată:** ponderile exacte ale indicelui compozit MEXC nu sunt publice, iar banda citește prețul spot de pe o singură platformă. Deci e o **aproximare** a prețului de decontare, nu o replică. Dar a aproxima mărimea corectă e mai bine decât a măsura precis mărimea greșită.

---

## Cum pornești

```bash
npm install
npm start
```

Apoi deschide **http://localhost:3011** (schimbi portul cu variabila `PORT`, ex. `PORT=3011 npm start`). Pe Windows, dublu-click pe `start.bat`.

### Pasul obligatoriu: calibrarea

Înainte de primul semnal, apasă **„Calibrează pe ultimele 30 de zile”**. Fără asta aplicația nu are cum să știe cât valorează un setup și va refuza corect orice intrare.

```
POST /api/calibrate    { "days": 30 }
```

Rezultatul se salvează în `calibration.json` și e folosit live până când jurnalul tău propriu are destule rezultate rezolvate, moment în care are prioritate (datele tale reale bat istoricul).

---

## Cum e gândit

- **Doar lumânări închise.** `lib/candles.js` taie lumânarea în formare înainte ca vreun detector să o vadă. Un verdict e o funcție pură a barelor confirmate, identificat prin `(simbol, barCloseTime)` — deci serverul emite exact o alertă per bară, nu una la fiecare scanare.
- **Paritate absolută între live și backtest.** Ambele apelează `engine.decide()` cu aceleași timeframe-uri. Dacă divergează, backtest-ul nu măsoară nimic util.
- **O singură taxonomie a declanșatorilor.** `TRIGGERS` în `lib/engine.js` este sursa unică de adevăr pentru „ce setup e acesta” și „ce fereastră i se potrivește”. Înainte, aceeași clasificare exista ca trei copii de regex în `engine.js`, `server.js` și `backtest.js`, care ajunseseră să nu mai coincidă.
- **Fereastra vine din declanșatorul principal**: evenimente impulsive de o singură lumânare (sweep, absorbție, breakout din squeeze, crossover) → **10 min**; setup-uri structurale (FVG, IFVG, shift de structură, divergență) → **30 min**.
- **Gemini nu decide nimic.** Primește numerele deja calculate și scrie justificarea în română. Opțional.

## Ce raportează backtest-ul

Nu un singur win-rate, ci ce e nevoie ca să judeci dacă cifra înseamnă ceva:

- **out-of-sample** pe o felie neatinsă, cu interval de încredere 95%
- **test binomial** față de o monedă aruncată (dacă `p > 0.05`, nu se distinge de noroc)
- **baseline „mereu UP” și „mereu DOWN”** pe exact aceleași bare
- **aceleași semnale evaluate la 10 ȘI la 30 de minute**, ca să vezi per setup care fereastră e mai bună
- **scor Brier + tabel de fiabilitate** — „70%” se întâmplă chiar în 70% din cazuri?
- **doar tranzacțiile aprobate de poarta EV**, cu EV realizat la payout-urile tale

Semnalele sunt distanțate cu cel puțin cea mai lungă fereastră, ca să nu împartă bare de rezultat între ele. Mostrele suprapuse sunt corelate și ar face testul de semnificație să pară mult mai puternic decât e.

## Endpoint-uri API

| Metodă | Rută | Descriere |
|---|---|---|
| GET | `/api/state` | config + ultimele verdicte + alerte |
| GET | `/api/signal?symbol=ETHUSDT` | analiză la cerere |
| POST | `/api/config` | salvează setările, repornește scanner-ul |
| POST | `/api/calibrate` | învață probabilitățile din istoric, salvează modelul |
| GET | `/api/calibration` | modelul de calibrare curent |
| GET | `/api/backtest?symbol=BTCUSDT&days=30` | evaluare out-of-sample completă |
| GET | `/api/stream` | flux live (SSE) |

## Order flow live

Pe lângă lumânări, aplicația citește dezechilibrul din order book (`/api/v3/depth`) și agresiunea tranzacțiilor (`/api/v3/aggTrades`). Nu se poate backtesta (MEXC nu dă istoric), deci e strict o confirmare live, validată prin jurnal.

Notă de corectitudine: clasificarea agresiunii cere acum explicit un boolean pe câmpul `m`. Înainte, orice tranzacție fără acel câmp era numărată tacit ca vânzare agresivă, ceea ce ar fi fabricat un bias permanent de scădere dacă bursa ar fi schimbat formatul.

---

## ⚠️ Ce nu poate face acest instrument

Trebuie spus direct, pentru că e diferența dintre a folosi aplicația corect și a pierde bani cu ea.

**Nu se poate construi un instrument care „generează în majoritate semnale de win".** Nu e o limitare de programare pe care s-o rezolv cu mai mult cod. Win-rate-ul nu e o proprietate a aplicației, ci a pieței: fie există o regularitate exploatabilă în mișcările de 10–30 de minute, fie nu. Codul o poate doar **măsura**, nu produce.

Iar bara e ridicată de payout, nu de noi. La payout 65% ai nevoie de **60.6%** acuratețe direcțională doar ca să fii pe zero. Asta e foarte greu de susținut consistent cu analiză tehnică pe orizonturi de minute, unde mișcarea e dominată de zgomot.

Ce face în schimb această versiune, și ce e realizabil:

- **nu mai minte** — fără repainting, fără probabilități inventate, fără cifre de backtest produse de o strategie diferită de cea care rulează
- **măsoară onest** — out-of-sample, cu baseline și marjă de eroare, deci vei ști dacă ai edge sau doar noroc
- **refuză când nu e nimic** — dovedit pe date aleatorii: 0 semnale aprobate din 264
- **dimensionează după edge** — mai mult unde statistica susține, nimic unde nu

Dacă după calibrare pe datele tale concluzia e că niciun setup nu bate pragul, aplicația îți va spune să nu intri. **Acela nu e un eșec al instrumentului — e singurul răspuns corect**, și te scutește de pierderi.

Pierderile sunt normale chiar și cu edge real: la 60% win-rate, 4 din 10 tranzacții pierd, și serii de 4-5 pierderi consecutive apar frecvent. De asta există plafonul de miză.

Validează pe demo. Strânge minim 30–50 de semnale rezolvate înainte de orice concluzie. Nu risca sume pe care nu ți le permiți să le pierzi. Aceasta nu este consultanță financiară.
```
