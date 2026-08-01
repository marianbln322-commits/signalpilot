'use strict';

// Standalone Android runtime. In the normal Node/Express web build this file is
// inert; the existing HTTP/SSE backend remains unchanged.
(function (global) {
  if (!global.SignalPilotAndroid || !global.SignalPilotCore) return;

  const { engine, learning, gemini } = global.SignalPilotCore;
  const MEXC = 'https://api.mexc.com';
  const BINANCE = 'https://data-api.binance.vision';
  const CONFIG_KEY = 'signalpilot-config-v1';
  const JOURNAL_KEY = 'signalpilot-journal-v1';
  const STATE_KEY = 'signalpilot-state-v1';
  const CONF_RANK = { 'Scăzut': 1, 'Mediu': 2, 'Ridicat': 3 };
  const DEFAULT_CONFIG = {
    symbols: ['BTCUSDT', 'ETHUSDT'],
    scanIntervalSec: 8,
    alertMinConfidence: 'Mediu',
    sniperMode: true,
    sniperRequireVolume: false,
    activeHoursUTC: [6, 7, 8, 9, 13, 14, 15, 16, 17],
    adaptiveInterval: false,
    payout10: 65,
    payout30: 82,
    fallbackWinRate: 55,
    useOrderFlow: true,
    requireOfAgree: false,
    useLearning: true,
    learningSuppressBelow: 45,
    gemini: { enabled: false, apiKey: '', model: 'gemini-3.5-flash' },
  };

  const listeners = new Map();
  const pendingHttp = new Map();
  const requestSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let requestSequence = 0;
  let config = loadConfig();
  let entries = loadJson(JOURNAL_KEY, []);
  let savedState = loadJson(STATE_KEY, {});
  let latest = savedState.latest || {};
  let alerts = savedState.alerts || [];
  let scanTimer = null;
  let resolveTimer = null;
  let scanRunning = false;
  let started = false;

  function loadRaw(key) {
    try {
      if (typeof global.SignalPilotAndroid.readStore === 'function') {
        return global.SignalPilotAndroid.readStore(key) || null;
      }
      return global.localStorage.getItem(key);
    } catch (error) {
      console.error(`Mobile storage read failed (${key}):`, error);
      return null;
    }
  }

  function saveRaw(key, value) {
    try {
      if (typeof global.SignalPilotAndroid.writeStore === 'function') {
        if (global.SignalPilotAndroid.writeStore(key, value) === false) {
          throw new Error('Stocarea nativă a refuzat scrierea');
        }
      } else {
        global.localStorage.setItem(key, value);
      }
      return true;
    } catch (error) {
      console.error(`Mobile storage write failed (${key}):`, error);
      return false;
    }
  }

  function loadJson(key, fallback) {
    try {
      const raw = loadRaw(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    return saveRaw(key, JSON.stringify(value));
  }

  function loadConfig() {
    const saved = loadJson(CONFIG_KEY, {});
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      gemini: { ...DEFAULT_CONFIG.gemini, ...(saved.gemini || {}) },
    };
  }

  function publicConfig() {
    return {
      ...config,
      gemini: { ...config.gemini, apiKey: config.gemini.apiKey ? '********' : '' },
      mobileStandalone: true,
      foregroundOnly: true,
    };
  }

  function persistState() {
    return saveJson(STATE_KEY, { latest, alerts: alerts.slice(0, 50) });
  }

  function persistJournal() {
    // Mobile file storage supports more than localStorage, but bound the journal
    // to keep startup and learning deterministic on low-memory phones.
    if (entries.length > 2500) {
      const alertsOnly = entries.filter((entry) => !entry.observation);
      const observations = entries.filter((entry) => entry.observation).slice(0, Math.max(0, 2500 - alertsOnly.length));
      entries = [...alertsOnly, ...observations]
        .sort((a, b) => Number(b.entryTs || 0) - Number(a.entryTs || 0))
        .slice(0, 2500);
    }
    return saveJson(JOURNAL_KEY, entries);
  }

  function emit(type, data) {
    const group = listeners.get(type);
    if (!group) return;
    for (const callback of [...group]) {
      try { callback(data); } catch (error) { console.error(`Mobile listener ${type}:`, error); }
    }
  }

  function on(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
    return () => listeners.get(type)?.delete(callback);
  }

  global.__signalPilotNativeResponse = function (requestId, status, body, error) {
    const pending = pendingHttp.get(String(requestId));
    if (!pending) return;
    pendingHttp.delete(String(requestId));
    if (error) pending.reject(new Error(error));
    else pending.resolve({ status: Number(status), ok: status >= 200 && status < 300, text: body || '' });
  };

  function nativeHttp(url, options = {}) {
    return new Promise((resolve, reject) => {
      const id = `${requestSession}-${++requestSequence}`;
      pendingHttp.set(id, { resolve, reject });
      const timeout = setTimeout(() => {
        if (!pendingHttp.has(id)) return;
        pendingHttp.delete(id);
        reject(new Error(`Timeout HTTP: ${url}`));
      }, options.timeoutMs || 30000);
      const wrappedResolve = resolve;
      const wrappedReject = reject;
      pendingHttp.set(id, {
        resolve: (value) => { clearTimeout(timeout); wrappedResolve(value); },
        reject: (error) => { clearTimeout(timeout); wrappedReject(error); },
      });
      try {
        global.SignalPilotAndroid.http(
          id,
          String(options.method || 'GET').toUpperCase(),
          url,
          options.body == null ? '' : String(options.body),
          JSON.stringify(options.headers || {})
        );
      } catch (error) {
        clearTimeout(timeout);
        pendingHttp.delete(id);
        reject(error);
      }
    });
  }

  async function httpJson(url, options = {}) {
    const response = await nativeHttp(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 180)}`);
    try { return JSON.parse(response.text); }
    catch { throw new Error(`Răspuns JSON invalid de la ${new URL(url).hostname}`); }
  }

  function mapKline(row) {
    return {
      openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
      closeTime: Number(row[6]), quoteVolume: Number(row[7]),
    };
  }

  async function fetchKlines(symbol, interval, limit = 200) {
    const url = `${MEXC}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const raw = await httpJson(url);
    if (!Array.isArray(raw)) throw new Error(`Klines MEXC invalide pentru ${symbol}`);
    return raw.map(mapKline);
  }

  async function fetchPrice(symbol) {
    const body = await httpJson(`${MEXC}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
    const value = Number(body.price);
    if (!Number.isFinite(value)) throw new Error(`Preț invalid pentru ${symbol}`);
    return value;
  }

  async function fetchPriceAt(symbol, timestamp) {
    const startTime = Math.floor(Number(timestamp));
    const url = `${MEXC}/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&startTime=${startTime}&endTime=${startTime + 60000}&limit=1`;
    const trades = await httpJson(url);
    const trade = Array.isArray(trades) ? trades[0] : null;
    const value = Number(trade?.p);
    const tradeTime = Number(trade?.T);
    if (!Number.isFinite(value) || !Number.isFinite(tradeTime) || tradeTime < startTime) {
      throw new Error(`Preț istoric exact indisponibil pentru ${symbol}`);
    }
    return { price: value, timestamp: tradeTime };
  }

  async function fetchMultiTimeframe(symbol) {
    const [five, fifteen, sixty] = await Promise.all([
      fetchKlines(symbol, '5m', 200),
      fetchKlines(symbol, '15m', 200),
      fetchKlines(symbol, '60m', 200),
    ]);
    return { '5m': five, '15m': fifteen, '60m': sixty };
  }

  async function fetchOrderFlow(symbol, depthLimit = 50, tradesLimit = 200) {
    const [depth, trades] = await Promise.all([
      httpJson(`${MEXC}/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${depthLimit}`),
      httpJson(`${MEXC}/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=${tradesLimit}`),
    ]);
    const sum = (rows) => Array.isArray(rows) ? rows.reduce((total, row) => total + Number(row[1] || 0), 0) : 0;
    const bidVol = sum(depth.bids);
    const askVol = sum(depth.asks);
    const imbalance = bidVol + askVol > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0;
    let buyVol = 0;
    let sellVol = 0;
    for (const trade of Array.isArray(trades) ? trades : []) {
      const quantity = Number(trade.q || 0);
      if (trade.m === false || trade.m === 'false') buyVol += quantity;
      else sellVol += quantity;
    }
    const delta = buyVol + sellVol > 0 ? (buyVol - sellVol) / (buyVol + sellVol) : 0;
    const pressure = (imbalance + delta) / 2;
    const state = pressure > 0.15 ? 'buy' : pressure < -0.15 ? 'sell' : 'neutru';
    return {
      imbalance: +imbalance.toFixed(3), delta: +delta.toFixed(3), pressure: +pressure.toFixed(3), state,
      bidVol: +bidVol.toFixed(2), askVol: +askVol.toFixed(2),
      buyVol: +buyVol.toFixed(2), sellVol: +sellVol.toFixed(2),
    };
  }

  function orderFlowAgreement(direction, orderFlow) {
    if (!orderFlow || orderFlow.state === 'neutru' || direction === 'NEUTRU') return 'neutru';
    const bullish = orderFlow.state === 'buy';
    if (direction === 'UP') return bullish ? 'confirmă' : 'conflict';
    if (direction === 'DOWN') return bullish ? 'conflict' : 'confirmă';
    return 'neutru';
  }

  function primarySetup(verdict) {
    const signal = (verdict.signals || []).find((item) => /sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band/i.test(item.label));
    if (!signal) return 'context';
    const label = signal.label.toLowerCase();
    if (label.includes('sweep')) return 'Liquidity Sweep';
    if (label.includes('squeeze')) return 'Squeeze breakout';
    if (label.includes('structure shift')) return 'Market Structure Shift';
    if (label.includes('ifvg')) return 'Inversion FVG';
    if (label.includes('fvg')) return 'FVG retest';
    if (label.includes('divergen')) return 'RSI divergence';
    if (label.includes('crossover')) return 'MACD crossover';
    if (label.includes('absorb') || label.includes('distribu')) return 'Volume absorption';
    if (label.includes('reversie') || label.includes('band')) return 'Bollinger bounce';
    return 'context';
  }

  function aggregate(rows) {
    const valid = rows.filter((entry) => entry.status === 'resolved');
    const wins = valid.filter((entry) => entry.win).length;
    return { n: valid.length, wins, winRate: valid.length ? +((wins / valid.length) * 100).toFixed(1) : null };
  }

  function recentByInterval(limit = 20) {
    const resolved = entries.filter((entry) => entry.status === 'resolved');
    return {
      tenMin: aggregate(resolved.filter((entry) => entry.interval === '10 minute').slice(0, limit)),
      thirtyMin: aggregate(resolved.filter((entry) => entry.interval === '30 minute').slice(0, limit)),
    };
  }

  function journalStats() {
    const resolved = entries.filter((entry) => entry.status === 'resolved' && !entry.observation);
    const symbols = [...new Set(resolved.map((entry) => entry.symbol))];
    return {
      overall: aggregate(resolved),
      sniper: aggregate(resolved.filter((entry) => entry.sniper)),
      nonSniper: aggregate(resolved.filter((entry) => !entry.sniper)),
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, aggregate(resolved.filter((entry) => entry.symbol === symbol))])),
      sniperBySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, aggregate(resolved.filter((entry) => entry.symbol === symbol && entry.sniper))])),
      byInterval: {
        '10 minute': aggregate(resolved.filter((entry) => entry.interval === '10 minute')),
        '30 minute': aggregate(resolved.filter((entry) => entry.interval === '30 minute')),
      },
      recentInterval: recentByInterval(20),
      pending: entries.filter((entry) => entry.status === 'pending').length,
      total: entries.length,
    };
  }

  function journalPayload(limit = 40) {
    return {
      stats: journalStats(),
      recent: entries.filter((entry) => !entry.observation).slice(0, limit),
      learning: learning.summary(entries),
    };
  }

  function recordJournal(signal) {
    const observation = !!signal.observation;
    const id = observation
      ? `obs-${signal.symbol}-${signal.candleOpen}`
      : `${signal.ts}-${signal.symbol}`;
    if (entries.some((entry) => entry.id === id)) return null;
    const horizonMinutes = signal.interval === '10 minute' ? 10 : 30;
    const entry = {
      id, observation, symbol: signal.symbol, directie: signal.directie,
      interval: signal.interval, incredere: signal.incredere, sniper: !!signal.sniper,
      setup: signal.setup || null,
      hourUTC: signal.hourUTC != null ? signal.hourUTC : new Date(signal.ts).getUTCHours(),
      ofState: signal.ofState || null, ofAgree: signal.ofAgree || null,
      entryPrice: Number(signal.price), entryTs: Number(signal.ts),
      resolveTs: Number(signal.ts) + horizonMinutes * 60 * 1000,
      status: 'pending', exitPrice: null, win: null,
    };
    const previousEntries = entries;
    entries = [entry, ...entries];
    if (!persistJournal()) {
      entries = previousEntries;
      throw new Error('Jurnalul nu a putut fi salvat pe telefon');
    }
    return entry;
  }

  async function resolveJournal() {
    const changes = [];
    const now = Date.now();
    for (const entry of entries) {
      if (entry.status !== 'pending' || now < entry.resolveTs) continue;
      try {
        const previous = {
          entry,
          exitPrice: entry.exitPrice,
          exitTs: entry.exitTs,
          resolutionSource: entry.resolutionSource,
          win: entry.win,
          status: entry.status,
        };
        const overdueMs = now - entry.resolveTs;
        if (overdueMs > 60000) {
          const historical = await fetchPriceAt(entry.symbol, entry.resolveTs);
          entry.exitPrice = historical.price;
          entry.exitTs = historical.timestamp;
          entry.resolutionSource = 'historical-trade';
        } else {
          entry.exitPrice = await fetchPrice(entry.symbol);
          entry.exitTs = now;
          entry.resolutionSource = 'live';
        }
        entry.win = entry.directie === 'UP' ? entry.exitPrice > entry.entryPrice : entry.exitPrice < entry.entryPrice;
        entry.status = 'resolved';
        changes.push(previous);
      } catch (error) {
        console.warn('Mobile journal resolve:', error.message);
      }
    }
    if (!changes.length) return;
    if (!persistJournal()) {
      for (const previous of changes) {
        Object.assign(previous.entry, {
          exitPrice: previous.exitPrice,
          exitTs: previous.exitTs,
          resolutionSource: previous.resolutionSource,
          win: previous.win,
          status: previous.status,
        });
      }
      console.error('Rezultatele jurnalului nu au putut fi salvate; modificările au fost anulate.');
      return;
    }
    emit('journal', journalPayload());
  }

  function applyEv(verdict) {
    if (verdict.directie === 'NEUTRU') return;
    const recent = recentByInterval(20);
    const wr10 = recent.tenMin.n >= 8 && recent.tenMin.winRate != null ? recent.tenMin.winRate : config.fallbackWinRate;
    const wr30 = recent.thirtyMin.n >= 8 && recent.thirtyMin.winRate != null ? recent.thirtyMin.winRate : config.fallbackWinRate;
    const p10 = config.payout10 / 100;
    const p30 = config.payout30 / 100;
    const ev = (winRate, payout) => (winRate / 100) * payout - (1 - winRate / 100);
    const ev10 = ev(wr10, p10);
    const ev30 = ev(wr30, p30);
    const natural = verdict.interval;
    if (config.adaptiveInterval && natural === '10 minute' && ev10 < 0 && ev30 > ev10) {
      verdict.interval = '30 minute';
      verdict.intervalAdapted = { from: '10 minute', reason: `payout 10 min slab → 30 min` };
    }
    const selected = verdict.interval === '30 minute' ? ev30 : ev10;
    verdict.ev = {
      payout10: config.payout10, payout30: config.payout30,
      breakEven10: +(100 / (1 + p10)).toFixed(1),
      breakEven30: +(100 / (1 + p30)).toFixed(1),
      wr10, wr30,
      ev10: +(ev10 * 100).toFixed(1), ev30: +(ev30 * 100).toFixed(1),
      chosen: verdict.interval, positive: selected > 0,
    };
  }

  async function mobileNarrate(symbol, verdict) {
    if (!config.gemini.enabled || !config.gemini.apiKey) return { used: false };
    const model = config.gemini.model || 'gemini-3.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.gemini.apiKey)}`;
    try {
      const response = await httpJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: gemini.buildPrompt(symbol, verdict) }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 500, responseMimeType: 'application/json' },
        }),
      });
      const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      return { used: true, ...parsed };
    } catch (error) {
      return { used: false, error: error.message };
    }
  }

  async function scanSymbol(symbol) {
    const mtf = await fetchMultiTimeframe(symbol);
    const verdict = engine.decide(mtf);
    verdict.symbol = symbol;
    applyEv(verdict);

    if (config.gemini.enabled && verdict.directie !== 'NEUTRU') {
      const ai = await mobileNarrate(symbol, verdict);
      if (ai.used) {
        verdict.ai = { justificare: ai.justificare, acord: ai.acord, risc: ai.risc, comentariu: ai.comentariu };
        if (ai.justificare) verdict.justificare = ai.justificare;
      } else if (ai.error) verdict.aiError = ai.error;
    }

    const hourUTC = new Date().getUTCHours();
    verdict.sniper = engine.sniperEligibility(verdict, hourUTC, config.activeHoursUTC, config.sniperRequireVolume);
    verdict.setup = primarySetup(verdict);

    if (config.useOrderFlow) {
      try {
        verdict.orderflow = await fetchOrderFlow(symbol);
        verdict.ofAgree = orderFlowAgreement(verdict.directie, verdict.orderflow);
      } catch (error) {
        verdict.orderflowError = error.message;
      }
    }

    if (config.useLearning) {
      verdict.learned = learning.evaluate(entries, {
        symbol, directie: verdict.directie, setup: verdict.setup,
        hourUTC, ofAgree: verdict.ofAgree,
      });
    }

    if (config.useLearning && verdict.directie !== 'NEUTRU') {
      recordJournal({
        observation: true,
        candleOpen: mtf['5m'].at(-1).openTime,
        symbol, directie: verdict.directie, interval: verdict.interval,
        incredere: verdict.incredere, sniper: false, setup: verdict.setup,
        hourUTC, ofState: verdict.orderflow?.state || null,
        ofAgree: verdict.ofAgree, price: verdict.price, ts: verdict.ts,
      });
    }

    const previous = latest[symbol];

    let shouldAlert;
    if (config.sniperMode) {
      shouldAlert = verdict.sniper.eligible && (!previous?.sniper?.eligible || previous.directie !== verdict.directie);
    } else {
      const confidence = verdict.directie !== 'NEUTRU' && CONF_RANK[verdict.incredere] >= CONF_RANK[config.alertMinConfidence];
      shouldAlert = confidence && (!previous || previous.directie !== verdict.directie || previous.incredere !== verdict.incredere);
    }
    if (shouldAlert && config.useOrderFlow && config.requireOfAgree && verdict.ofAgree === 'conflict') {
      shouldAlert = false;
      verdict.suppressed = 'order flow în conflict cu direcția';
    }
    if (shouldAlert && config.useLearning && verdict.learned?.ready &&
        verdict.learned.estimate != null && verdict.learned.estimate < config.learningSuppressBelow) {
      shouldAlert = false;
      verdict.suppressed = `istoricul tău dă doar ${verdict.learned.estimate}% pe acest tipar`;
    }

    let alert = null;
    let alertJournalEntry = null;
    const previousAlerts = alerts;
    if (shouldAlert) {
      alert = {
        symbol, directie: verdict.directie, interval: verdict.interval,
        incredere: verdict.incredere, price: verdict.price,
        justificare: verdict.justificare, sniper: !!verdict.sniper?.eligible,
        ofState: verdict.orderflow?.state || null, ofAgree: verdict.ofAgree || null,
        ts: verdict.ts,
      };
      alertJournalEntry = recordJournal({ ...alert, setup: verdict.setup, hourUTC });
      alerts = [alert, ...alerts].slice(0, 50);
    }

    latest[symbol] = verdict;
    if (!persistState()) {
      if (previous === undefined) delete latest[symbol];
      else latest[symbol] = previous;
      alerts = previousAlerts;
      if (alertJournalEntry) {
        entries = entries.filter((entry) => entry.id !== alertJournalEntry.id);
        if (!persistJournal()) console.error('Nu am putut anula intrarea de jurnal după eșecul stocării stării.');
      }
      throw new Error('Starea semnalului nu a putut fi salvată pe telefon');
    }

    emit('signal', verdict);
    if (alert) {
      emit('alert', alert);
      emit('journal', journalPayload());
    }
    return verdict;
  }

  async function scanAll() {
    if (scanRunning || document.visibilityState === 'hidden') return;
    scanRunning = true;
    try {
      for (const raw of config.symbols) {
        const symbol = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol) continue;
        try { await scanSymbol(symbol); }
        catch (error) { emit('error', { symbol, message: error.message }); }
      }
      emit('connection', { online: true });
    } finally {
      scanRunning = false;
    }
  }

  function restartScheduler() {
    if (scanTimer) clearInterval(scanTimer);
    if (resolveTimer) clearInterval(resolveTimer);
    scanTimer = setInterval(scanAll, Math.max(3, Number(config.scanIntervalSec) || 8) * 1000);
    resolveTimer = setInterval(resolveJournal, 10000);
    scanAll();
    resolveJournal();
  }

  function snapshot() {
    return {
      latest, alerts,
      journal: { stats: journalStats(), recent: entries.filter((entry) => !entry.observation).slice(0, 40) },
      learning: learning.summary(entries),
    };
  }

  function connect() {
    if (!started) {
      started = true;
      restartScheduler();
    }
    emit('snapshot', snapshot());
    emit('connection', { online: true });
  }

  function saveConfig(body) {
    const previousConfig = JSON.parse(JSON.stringify(config));
    if (Array.isArray(body.symbols) && body.symbols.length) {
      config.symbols = body.symbols.map((item) => String(item).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    }
    if (body.scanIntervalSec != null) config.scanIntervalSec = Math.max(3, Number(body.scanIntervalSec) || 8);
    if (CONF_RANK[body.alertMinConfidence]) config.alertMinConfidence = body.alertMinConfidence;
    for (const key of ['sniperMode', 'sniperRequireVolume', 'adaptiveInterval', 'useOrderFlow', 'requireOfAgree', 'useLearning']) {
      if (typeof body[key] === 'boolean') config[key] = body[key];
    }
    if (Array.isArray(body.activeHoursUTC)) {
      config.activeHoursUTC = body.activeHoursUTC.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
    }
    for (const key of ['payout10', 'payout30']) {
      const value = Number(body[key]);
      if (value > 0 && value <= 500) config[key] = value;
    }
    if (body.fallbackWinRate != null) {
      const value = Number(body.fallbackWinRate);
      if (value >= 40 && value <= 70) config.fallbackWinRate = value;
    }
    if (body.learningSuppressBelow != null) {
      const value = Number(body.learningSuppressBelow);
      if (value >= 30 && value <= 55) config.learningSuppressBelow = value;
    }
    if (body.gemini) {
      config.gemini.enabled = !!body.gemini.enabled;
      if (String(body.gemini.model || '').trim()) config.gemini.model = String(body.gemini.model).trim();
      if (String(body.gemini.apiKey || '') && !String(body.gemini.apiKey).includes('*')) {
        config.gemini.apiKey = String(body.gemini.apiKey).trim();
      }
    }
    if (!saveJson(CONFIG_KEY, config)) {
      config = previousConfig;
      throw new Error('Configurația nu a putut fi salvată pe telefon');
    }
    restartScheduler();
    return { ok: true, config: publicConfig() };
  }

  async function testAi(body) {
    const apiKey = body?.apiKey && !String(body.apiKey).includes('*') ? String(body.apiKey).trim() : config.gemini.apiKey;
    const model = body?.model || config.gemini.model;
    if (!apiKey) return { ok: false, error: 'no key' };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      await httpJson(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Raspunde cu un singur cuvant: ok' }] }] }),
      });
      return { ok: true, model };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function fetchBinanceHistory(symbol, interval, days, endTimeMs = null) {
    const end = endTimeMs || Date.now();
    let start = end - days * 86400000;
    const rows = [];
    let guard = 0;
    while (start < end && guard++ < 120) {
      const url = `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=1000&startTime=${start}`;
      const batch = await httpJson(url, { timeoutMs: 45000 });
      if (!Array.isArray(batch) || !batch.length) break;
      rows.push(...batch.map(mapKline));
      const next = Number(batch.at(-1)[0]) + 1;
      if (next <= start) break;
      start = next;
      if (batch.length < 1000) break;
    }
    return [...new Map(rows.filter((row) => row.openTime <= end).map((row) => [row.openTime, row])).values()]
      .sort((a, b) => a.openTime - b.openTime);
  }

  async function runBacktest(symbol, days, endDaysAgo = 0) {
    const endTime = Date.now() - endDaysAgo * 86400000;
    const tf5 = await fetchBinanceHistory(symbol, '5m', days, endTime);
    const tf15 = await fetchBinanceHistory(symbol, '15m', days, endTime);
    const WINDOW = 200;
    const stats = {
      symbol, source: 'binance.vision (Android)', days, endDaysAgo, totalCandles: tf5.length, evaluated: 0,
      byConfidence: { Ridicat: { n: 0, wins: 0 }, Mediu: { n: 0, wins: 0 }, 'Scăzut': { n: 0, wins: 0 } },
      byDirection: { UP: { n: 0, wins: 0 }, DOWN: { n: 0, wins: 0 } },
    };
    let lastCounted = -999;
    let tf15End = 0;
    for (let index = WINDOW; index < tf5.length - 6; index++) {
      if (index % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const window5 = tf5.slice(index - WINDOW, index + 1);
      while (tf15End < tf15.length && tf15[tf15End].closeTime <= tf5[index].closeTime) tf15End++;
      const window15 = tf15.slice(Math.max(0, tf15End - WINDOW), tf15End);
      if (window15.length < 60) continue;
      const verdict = engine.decide({ '5m': window5, '15m': window15 });
      if (verdict.directie === 'NEUTRU' || index - lastCounted < 2) continue;
      lastCounted = index;
      const horizon = verdict.interval === '10 minute' ? 2 : 6;
      const entry = tf5[index].close;
      const exit = tf5[index + horizon].close;
      const win = verdict.directie === 'UP' ? exit > entry : exit < entry;
      stats.evaluated++;
      stats.byConfidence[verdict.incredere].n++;
      stats.byDirection[verdict.directie].n++;
      if (win) {
        stats.byConfidence[verdict.incredere].wins++;
        stats.byDirection[verdict.directie].wins++;
      }
    }
    const rate = (row) => row.n ? +((row.wins / row.n) * 100).toFixed(1) : null;
    stats.winRate = {
      overall: stats.evaluated ? +((Object.values(stats.byConfidence).reduce((sum, row) => sum + row.wins, 0) / stats.evaluated) * 100).toFixed(1) : null,
      Ridicat: rate(stats.byConfidence.Ridicat), Mediu: rate(stats.byConfidence.Mediu),
      'Scăzut': rate(stats.byConfidence['Scăzut']), UP: rate(stats.byDirection.UP), DOWN: rate(stats.byDirection.DOWN),
    };
    return stats;
  }

  async function request(path, options = {}) {
    const url = new URL(path, 'https://signalpilot.local');
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.pathname === '/api/state') {
      return { config: publicConfig(), ...snapshot() };
    }
    if (url.pathname === '/api/journal') return { stats: journalStats(), recent: entries.filter((entry) => !entry.observation).slice(0, 100) };
    if (url.pathname === '/api/learning') return learning.summary(entries);
    if (url.pathname === '/api/signal') {
      const symbol = String(url.searchParams.get('symbol') || config.symbols[0]).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!symbol) throw new Error('Simbol invalid');
      return scanSymbol(symbol);
    }
    if (url.pathname === '/api/config' && String(options.method || 'GET').toUpperCase() === 'POST') return saveConfig(body);
    if (url.pathname === '/api/test-ai' && String(options.method || 'GET').toUpperCase() === 'POST') return testAi(body);
    if (url.pathname === '/api/journal/reset' && String(options.method || 'GET').toUpperCase() === 'POST') {
      const previousEntries = entries;
      entries = [];
      if (!saveJson(JOURNAL_KEY, entries)) {
        entries = previousEntries;
        throw new Error('Jurnalul nu a putut fi resetat pe telefon');
      }
      emit('journal', journalPayload());
      return { ok: true };
    }
    if (url.pathname === '/api/backtest') {
      const symbol = String(url.searchParams.get('symbol') || config.symbols[0]).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!symbol) throw new Error('Simbol invalid');
      const days = Math.min(60, Math.max(3, Number(url.searchParams.get('days')) || 15));
      const endDaysAgo = Math.max(0, Number(url.searchParams.get('endDaysAgo')) || 0);
      return runBacktest(symbol, days, endDaysAgo);
    }
    throw new Error(`Rută mobilă necunoscută: ${url.pathname}`);
  }

  function nativeNotify(title, body) {
    try { global.SignalPilotAndroid.notify(String(title), String(body)); } catch { /* optional */ }
  }

  function resume() {
    if (!started) return;
    scanAll();
    resolveJournal();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });

  global.SignalPilotMobile = Object.freeze({
    on, connect, request, resume, notify: nativeNotify,
    isStandalone: true,
  });
})(window);
