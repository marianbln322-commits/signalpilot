'use strict';

// Standalone Android runtime that mirrors the canonical localhost:3001 server
// in-process. It is inert in desktop browsers, where Express + SSE remain used.
(function (global) {
  if (!global.SignalPilotAndroid || !global.SignalPilotCore) return;

  const { engine, gemini } = global.SignalPilotCore;
  const MEXC = 'https://api.mexc.com';
  const BINANCE = 'https://data-api.binance.vision';
  const CONFIG_KEY = 'signalpilot-3001-config-v1';
  const JOURNAL_KEY = 'signalpilot-3001-journal-v1';
  const CONF_RANK = { 'Scăzut': 1, 'Mediu': 2, 'Ridicat': 3 };
  const DEFAULT_CONFIG = {
    symbols: ['BTCUSDT', 'ETHUSDT'],
    scanIntervalSec: 8,
    alertMinConfidence: 'Mediu',
    sniperMode: true,
    sniperRequireVolume: true,
    activeHoursUTC: [6, 7, 8, 9, 13, 14, 15, 16, 17],
    gemini: { enabled: false, apiKey: '', model: 'gemini-3.5-flash' },
  };

  const listeners = new Map();
  const pendingHttp = new Map();
  const requestSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let requestSequence = 0;
  let config = loadConfig();
  let entries = loadJson(JOURNAL_KEY, []);
  let latest = {};
  let alerts = [];
  let scanTimer = null;
  let resolveTimer = null;
  let scanRunning = false;
  let resolveRunning = false;
  let started = false;
  let lifecycleEpoch = 0;

  function loadRaw(key) {
    try {
      return global.SignalPilotAndroid.readStore(key) || null;
    } catch (error) {
      console.error(`Mobile storage read failed (${key}):`, error);
      return null;
    }
  }

  function saveRaw(key, value) {
    try {
      if (global.SignalPilotAndroid.writeStore(key, value) === false) {
        throw new Error('Stocarea nativă a refuzat scrierea');
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
    const saved = loadJson(CONFIG_KEY, null);
    return saved ? { ...DEFAULT_CONFIG, ...saved } : { ...DEFAULT_CONFIG };
  }

  function publicConfig() {
    return {
      ...config,
      gemini: { ...config.gemini, apiKey: config.gemini && config.gemini.apiKey ? '********' : '' },
    };
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

  function ensureForeground(epoch) {
    if (epoch !== lifecycleEpoch || document.visibilityState === 'hidden') {
      const error = new Error('Scanare suspendată în fundal');
      error.foregroundPause = true;
      throw error;
    }
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
      const timeout = setTimeout(() => {
        if (!pendingHttp.has(id)) return;
        pendingHttp.delete(id);
        reject(new Error(`Timeout HTTP: ${url}`));
      }, options.timeoutMs || 45000);
      pendingHttp.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
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
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 200)}`);
    try { return JSON.parse(response.text); }
    catch { throw new Error('Răspuns JSON invalid'); }
  }

  function mapKline(row) {
    return {
      openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
      closeTime: Number(row[6]), quoteVolume: Number(row[7]),
    };
  }

  async function fetchKlines(symbol, interval, limit = 200) {
    const url = `${MEXC}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const raw = await httpJson(url, { headers: { Accept: 'application/json' } });
    if (!Array.isArray(raw)) throw new Error(`Unexpected klines response for ${symbol}`);
    return raw.map(mapKline);
  }

  async function fetchMultiTimeframe(symbol) {
    const results = {};
    await Promise.all(['5m', '15m'].map(async (timeframe) => {
      results[timeframe] = await fetchKlines(symbol, timeframe, 200);
    }));
    return results;
  }

  async function fetchPrice(symbol) {
    const body = await httpJson(`${MEXC}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
    const price = Number(body.price);
    if (!Number.isFinite(price)) throw new Error(`Preț invalid pentru ${symbol}`);
    return price;
  }

  function agg(rows) {
    const n = rows.length;
    const wins = rows.filter((entry) => entry.win).length;
    return { n, wins, winRate: n ? +((wins / n) * 100).toFixed(1) : null };
  }

  function journalStats() {
    const resolved = entries.filter((entry) => entry.status === 'resolved');
    const symbols = [...new Set(resolved.map((entry) => entry.symbol))];
    return {
      overall: agg(resolved),
      sniper: agg(resolved.filter((entry) => entry.sniper)),
      nonSniper: agg(resolved.filter((entry) => !entry.sniper)),
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, agg(resolved.filter((entry) => entry.symbol === symbol))])),
      sniperBySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, agg(resolved.filter((entry) => entry.symbol === symbol && entry.sniper))])),
      pending: entries.filter((entry) => entry.status === 'pending').length,
      total: entries.length,
    };
  }

  function journalPayload(limit = 40) {
    return { stats: journalStats(), recent: entries.slice(0, limit) };
  }

  function recordJournal(signal) {
    const horizonMin = signal.interval === '10 minute' ? 10 : 30;
    const id = `${signal.ts}-${signal.symbol}`;
    if (entries.some((entry) => entry.id === id)) return null;
    const entry = {
      id,
      symbol: signal.symbol,
      directie: signal.directie,
      interval: signal.interval,
      incredere: signal.incredere,
      sniper: !!signal.sniper,
      entryPrice: signal.price,
      entryTs: signal.ts,
      resolveTs: signal.ts + horizonMin * 60 * 1000,
      status: 'pending',
      exitPrice: null,
      win: null,
    };
    const previous = entries;
    entries = [entry, ...entries];
    if (entries.length > 2000) entries.pop();
    if (!saveJson(JOURNAL_KEY, entries)) {
      entries = previous;
      throw new Error('Jurnalul nu a putut fi salvat pe telefon');
    }
    return entry;
  }

  async function resolveJournal() {
    if (resolveRunning || document.visibilityState === 'hidden') return;
    const epoch = lifecycleEpoch;
    resolveRunning = true;
    try {
      const now = Date.now();
      const resolutions = [];
      for (const entry of entries) {
        if (entry.status !== 'pending' || now < entry.resolveTs) continue;
        try {
          const price = await fetchPrice(entry.symbol);
          ensureForeground(epoch);
          if (Number.isFinite(price)) resolutions.push({ entry, price });
        } catch (error) {
          if (error.foregroundPause || epoch !== lifecycleEpoch || document.visibilityState === 'hidden') return;
          // Canonical behavior retries this entry on the next resolver pass.
        }
      }
      ensureForeground(epoch);
      if (resolutions.length) {
        for (const { entry, price } of resolutions) {
          entry.exitPrice = price;
          entry.win = entry.directie === 'UP' ? price > entry.entryPrice : price < entry.entryPrice;
          entry.status = 'resolved';
        }
        if (!saveJson(JOURNAL_KEY, entries)) throw new Error('Jurnalul rezolvat nu a putut fi salvat pe telefon');
        emit('journal', journalPayload());
        for (const { entry } of resolutions) {
          console.log(`[RESOLVED] ${entry.symbol} ${entry.directie} ${entry.entryPrice}->${entry.exitPrice} => ${entry.win ? 'WIN' : 'LOSS'}`);
        }
      }
    } catch (error) {
      if (!error.foregroundPause) console.error('Journal resolve error:', error.message);
    } finally {
      resolveRunning = false;
    }
  }

  async function mobileNarrate(symbol, verdict) {
    if (!config.gemini || !config.gemini.enabled || !config.gemini.apiKey) return { used: false };
    const model = config.gemini.model || 'gemini-3.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.gemini.apiKey)}`;
    const body = {
      contents: [{ parts: [{ text: gemini.buildPrompt(symbol, verdict) }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 500, responseMimeType: 'application/json' },
    };
    try {
      const response = await httpJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const match = text.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : null;
      }
      return parsed ? { used: true, ...parsed } : { used: false, error: 'unparseable AI response' };
    } catch (error) {
      return { used: false, error: String(error.message || error) };
    }
  }

  async function scanSymbol(symbol, epoch = lifecycleEpoch) {
    ensureForeground(epoch);
    const mtf = await fetchMultiTimeframe(symbol);
    ensureForeground(epoch);
    const verdict = engine.decide(mtf);
    verdict.symbol = symbol;

    if (config.gemini && config.gemini.enabled && config.gemini.apiKey && verdict.directie !== 'NEUTRU') {
      const ai = await mobileNarrate(symbol, verdict);
      ensureForeground(epoch);
      if (ai.used) {
        verdict.ai = { justificare: ai.justificare, acord: ai.acord, risc: ai.risc, comentariu: ai.comentariu };
        if (ai.justificare) verdict.justificare = ai.justificare;
      } else if (ai.error) {
        verdict.aiError = ai.error;
      }
    }

    const hourUTC = new Date().getUTCHours();
    verdict.sniper = engine.sniperEligibility(verdict, hourUTC, config.activeHoursUTC, config.sniperRequireVolume);
    ensureForeground(epoch);

    const previous = latest[symbol];
    latest[symbol] = verdict;
    emit('signal', verdict);

    let shouldAlert;
    if (config.sniperMode) {
      const wasEligible = previous && previous.sniper && previous.sniper.eligible;
      shouldAlert = verdict.sniper.eligible && (!wasEligible || previous.directie !== verdict.directie);
    } else {
      const meetsConfidence = verdict.directie !== 'NEUTRU' &&
        CONF_RANK[verdict.incredere] >= CONF_RANK[config.alertMinConfidence];
      const changed = !previous || previous.directie !== verdict.directie || previous.incredere !== verdict.incredere;
      shouldAlert = meetsConfidence && changed;
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
      const logged = recordJournal({ ...alert });
      emit('alert', alert);
      if (logged) emit('journal', journalPayload());
      console.log(`[ALERT${alert.sniper ? ' 🎯 SNIPER' : ''}] ${symbol}: ${verdict.directie} ${verdict.interval} (${verdict.incredere}) @ ${verdict.price}`);
    }
    return verdict;
  }

  async function scanAll() {
    if (scanRunning || document.visibilityState === 'hidden') return;
    const epoch = lifecycleEpoch;
    scanRunning = true;
    try {
      for (const symbol of config.symbols) {
        try {
          await scanSymbol(symbol, epoch);
        } catch (error) {
          if (error.foregroundPause || epoch !== lifecycleEpoch || document.visibilityState === 'hidden') return;
          console.error(`Scan error ${symbol}:`, error.message);
          emit('error', { symbol, message: error.message });
        }
      }
      ensureForeground(epoch);
      emit('connection', { online: true });
    } catch (error) {
      if (!error.foregroundPause) console.error('Scan scheduler error:', error.message);
    } finally {
      scanRunning = false;
    }
  }

  function restartScheduler() {
    if (scanTimer) clearInterval(scanTimer);
    if (resolveTimer) clearInterval(resolveTimer);
    scanTimer = setInterval(scanAll, Math.max(3, config.scanIntervalSec) * 1000);
    resolveTimer = setInterval(resolveJournal, 10000);
    scanAll();
  }

  function snapshot() {
    return { latest, alerts, journal: journalPayload() };
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
    const previous = config;
    config = {
      ...config,
      gemini: { ...(config.gemini || DEFAULT_CONFIG.gemini) },
    };
    if (Array.isArray(body.symbols) && body.symbols.length) {
      config.symbols = body.symbols.map((symbol) => String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, ''));
    }
    if (body.scanIntervalSec) config.scanIntervalSec = Math.max(3, Number(body.scanIntervalSec));
    if (body.alertMinConfidence && CONF_RANK[body.alertMinConfidence]) config.alertMinConfidence = body.alertMinConfidence;
    if (typeof body.sniperMode === 'boolean') config.sniperMode = body.sniperMode;
    if (typeof body.sniperRequireVolume === 'boolean') config.sniperRequireVolume = body.sniperRequireVolume;
    if (Array.isArray(body.activeHoursUTC)) {
      config.activeHoursUTC = body.activeHoursUTC
        .map((hour) => Number(hour))
        .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
    }
    if (body.gemini) {
      config.gemini.enabled = !!body.gemini.enabled;
      if (typeof body.gemini.model === 'string' && body.gemini.model.trim()) config.gemini.model = body.gemini.model.trim();
      if (typeof body.gemini.apiKey === 'string' && body.gemini.apiKey && !body.gemini.apiKey.includes('*')) {
        config.gemini.apiKey = body.gemini.apiKey.trim();
      }
    }
    if (!saveJson(CONFIG_KEY, config)) {
      config = previous;
      throw new Error('Configurația nu a putut fi salvată pe telefon');
    }
    restartScheduler();
    return { ok: true, config: publicConfig() };
  }

  async function testAi(body) {
    const key = body?.apiKey && !String(body.apiKey).includes('*')
      ? String(body.apiKey).trim()
      : config.gemini.apiKey;
    const model = body?.model || config.gemini.model;
    if (!key) return { ok: false, error: 'no key' };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    try {
      await httpJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Raspunde cu un singur cuvant: ok' }] }] }),
      });
      return { ok: true, model };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }

  async function fetchHistory(symbol, interval, days, maxPerRequest = 1000, endTimeMs = null) {
    const end = endTimeMs || Date.now();
    let start = end - days * 86400 * 1000;
    const all = [];
    let guard = 0;
    while (start < end && guard < 120) {
      guard++;
      const url = `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${maxPerRequest}&startTime=${start}`;
      const response = await nativeHttp(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) break;
      const raw = JSON.parse(response.text);
      if (!Array.isArray(raw) || raw.length === 0) break;
      all.push(...raw.map(mapKline));
      const lastOpen = Number(raw[raw.length - 1][0]);
      if (lastOpen <= start) break;
      start = lastOpen + 1;
      if (raw.length < maxPerRequest) break;
    }
    const seen = new Map();
    for (const candle of all.filter((item) => item.openTime <= end)) seen.set(candle.openTime, candle);
    return [...seen.values()].sort((a, b) => a.openTime - b.openTime);
  }

  function categorize(label) {
    const value = label.toLowerCase();
    if (value.includes('sweep')) return 'Liquidity Sweep';
    if (value.includes('squeeze')) return 'Bollinger Squeeze breakout';
    if (value.includes('structure shift')) return 'Market Structure Shift';
    if (value.includes('ifvg')) return 'Inversion FVG retest';
    if (value.includes('fvg')) return 'FVG retest';
    if (value.includes('divergen')) return 'RSI divergence';
    if (value.includes('crossover')) return 'MACD crossover';
    if (value.includes('absorb') || value.includes('distribu')) return 'Volume absorption';
    if (value.includes('reversie') || value.includes('band')) return 'Bollinger bounce';
    return 'other';
  }

  async function runBacktest(symbol, options = {}) {
    const epoch = lifecycleEpoch;
    ensureForeground(epoch);
    const days = Math.min(60, Math.max(3, options.days || 15));
    const endDaysAgo = Math.max(0, options.endDaysAgo || 0);
    const endTimeMs = endDaysAgo > 0 ? Date.now() - endDaysAgo * 86400 * 1000 : null;
    const [tf5, tf15] = await Promise.all([
      fetchHistory(symbol, '5m', days, 1000, endTimeMs),
      fetchHistory(symbol, '15m', days, 1000, endTimeMs),
    ]);
    ensureForeground(epoch);
    const stats = {
      symbol,
      source: 'binance.vision (proxy pentru istoric adânc)',
      days,
      totalCandles: tf5.length,
      evaluated: 0,
      byConfidence: {
        Ridicat: { n: 0, wins: 0 },
        Mediu: { n: 0, wins: 0 },
        'Scăzut': { n: 0, wins: 0 },
      },
      byDirection: { UP: { n: 0, wins: 0 }, DOWN: { n: 0, wins: 0 } },
      bySetup: {},
      strong: { n: 0, wins: 0 },
      veryStrong: { n: 0, wins: 0 },
      byHour: {},
      sweepAll: { n: 0, wins: 0 },
      sweepActiveHours: { n: 0, wins: 0 },
      sniper: { n: 0, wins: 0 },
      trades: [],
    };
    const activeHours = new Set([6, 7, 8, 9, 13, 14, 15, 16, 17]);
    const triggerPattern = /sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band/i;
    const windowSize = 200;
    let lastCountedIndex = -999;

    for (let index = windowSize; index < tf5.length - 6; index++) {
      if (index % 100 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        ensureForeground(epoch);
      }
      const window5 = tf5.slice(index - windowSize, index + 1);
      const currentCloseTime = tf5[index].closeTime;
      const window15 = tf15.filter((candle) => candle.closeTime <= currentCloseTime).slice(-windowSize);
      if (window15.length < 60) continue;
      let verdict;
      try {
        verdict = engine.decide({ '5m': window5, '15m': window15 });
      } catch {
        continue;
      }
      if (verdict.directie === 'NEUTRU') continue;
      if (index - lastCountedIndex < 2) continue;
      lastCountedIndex = index;
      const horizon = verdict.interval === '10 minute' ? 2 : 6;
      const outputIndex = index + horizon;
      if (outputIndex >= tf5.length) continue;
      const entry = tf5[index].close;
      const exit = tf5[outputIndex].close;
      const win = verdict.directie === 'UP' ? exit > entry : exit < entry;
      stats.evaluated++;
      const confidence = verdict.incredere;
      stats.byConfidence[confidence].n++;
      stats.byDirection[verdict.directie].n++;
      if (win) {
        stats.byConfidence[confidence].wins++;
        stats.byDirection[verdict.directie].wins++;
      }
      const primaryTrigger = (verdict.signals || []).find((signal) => triggerPattern.test(signal.label));
      let isSweep = false;
      let sweepVolumeConfirmed = false;
      if (primaryTrigger) {
        const category = categorize(primaryTrigger.label);
        if (!stats.bySetup[category]) stats.bySetup[category] = { n: 0, wins: 0 };
        stats.bySetup[category].n++;
        if (win) stats.bySetup[category].wins++;
        isSweep = category === 'Liquidity Sweep';
        sweepVolumeConfirmed = isSweep && /volum ridicat/i.test(primaryTrigger.label);
      }
      const hour = new Date(tf5[index].openTime).getUTCHours();
      if (!stats.byHour[hour]) stats.byHour[hour] = { n: 0, wins: 0 };
      stats.byHour[hour].n++;
      if (win) stats.byHour[hour].wins++;
      const inActive = activeHours.has(hour);
      if (isSweep) {
        stats.sweepAll.n++; if (win) stats.sweepAll.wins++;
        if (inActive) { stats.sweepActiveHours.n++; if (win) stats.sweepActiveHours.wins++; }
        if (inActive && sweepVolumeConfirmed) { stats.sniper.n++; if (win) stats.sniper.wins++; }
      }
      const absNet = Math.abs(verdict.scores.net);
      if (absNet >= 5) { stats.strong.n++; if (win) stats.strong.wins++; }
      if (absNet >= 7) { stats.veryStrong.n++; if (win) stats.veryStrong.wins++; }
      if (stats.trades.length < 200) {
        stats.trades.push({
          time: new Date(tf5[index].openTime).toISOString(),
          directie: verdict.directie,
          interval: verdict.interval,
          incredere: confidence,
          entry: +entry.toFixed(2),
          exit: +exit.toFixed(2),
          win,
        });
      }
    }

    const pct = (row) => row.n ? +((row.wins / row.n) * 100).toFixed(1) : null;
    stats.winRate = {
      overall: pct({ n: stats.evaluated, wins: Object.values(stats.byConfidence).reduce((sum, row) => sum + row.wins, 0) }),
      Ridicat: pct(stats.byConfidence.Ridicat),
      Mediu: pct(stats.byConfidence.Mediu),
      'Scăzut': pct(stats.byConfidence['Scăzut']),
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
        .map(([hour, value]) => [hour, { winRate: pct(value), n: value.n }])
        .sort((a, b) => Number(a[0]) - Number(b[0]))
    );
    stats.setupWinRate = Object.fromEntries(
      Object.entries(stats.bySetup)
        .map(([key, value]) => [key, { winRate: pct(value), n: value.n }])
        .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0))
    );
    ensureForeground(epoch);
    return stats;
  }

  async function request(path, options = {}) {
    const url = new URL(path, 'https://mobile.invalid');
    const body = options.body ? JSON.parse(options.body) : {};
    const method = String(options.method || 'GET').toUpperCase();
    if (url.pathname === '/api/state') {
      return { config: publicConfig(), latest, alerts, journal: journalPayload() };
    }
    if (url.pathname === '/api/journal') return { stats: journalStats(), recent: entries.slice(0, 100) };
    if (url.pathname === '/api/signal') {
      const symbol = String(url.searchParams.get('symbol') || config.symbols[0]).toUpperCase();
      return scanSymbol(symbol);
    }
    if (url.pathname === '/api/config' && method === 'POST') return saveConfig(body);
    if (url.pathname === '/api/test-ai' && method === 'POST') return testAi(body);
    if (url.pathname === '/api/journal/reset' && method === 'POST') {
      const previous = entries;
      entries = [];
      if (!saveJson(JOURNAL_KEY, entries)) {
        entries = previous;
        throw new Error('Jurnalul nu a putut fi resetat pe telefon');
      }
      emit('journal', journalPayload());
      return { ok: true };
    }
    if (url.pathname === '/api/backtest') {
      const symbol = String(url.searchParams.get('symbol') || config.symbols[0]).toUpperCase();
      const days = Math.min(60, Math.max(3, Number(url.searchParams.get('days')) || 15));
      const endDaysAgo = Math.max(0, Number(url.searchParams.get('endDaysAgo')) || 0);
      return runBacktest(symbol, { days, endDaysAgo });
    }
    throw new Error(`Rută mobilă necunoscută: ${url.pathname}`);
  }

  function notify(title, body) {
    try { global.SignalPilotAndroid.notify(String(title), String(body)); } catch { /* optional */ }
  }

  function pause() {
    lifecycleEpoch++;
  }

  function resume() {
    if (!started || document.visibilityState === 'hidden') return;
    scanAll();
    resolveJournal();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else pause();
  });

  global.SignalPilotMobile = Object.freeze({
    on,
    connect,
    request,
    events: Object.freeze({ on }),
    notify,
    pause,
    resume,
    isStandalone: true,
  });
})(window);
