'use strict';

const zlib = require('zlib');
const { contractBoundaries } = require('./contract-timing');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_LIVE_MODEL = 'gemini-3.6-flash';
const STRATEGIST_VERSION = 'gemini-live-strategist-v1';
const TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '30m', '60m']);
const TIMEFRAME_MS = Object.freeze({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '60m': 3_600_000 });
const CANDLES_PER_TIMEFRAME = 120;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function renderChartPng(snapshot, { width = 960, panelHeight = 142 } = {}) {
  const height = panelHeight * TIMEFRAMES.length;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    pixels[index] = 11; pixels[index + 1] = 15; pixels[index + 2] = 21;
  }
  const setPixel = (x, y, color) => {
    const px = Math.round(x); const py = Math.round(y);
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const offset = (py * width + px) * 3;
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
  };
  const line = (x0, y0, x1, y1, color) => {
    let startX = Math.round(x0); let startY = Math.round(y0);
    const endX = Math.round(x1); const endY = Math.round(y1);
    const dx = Math.abs(endX - startX); const sx = startX < endX ? 1 : -1;
    const dy = -Math.abs(endY - startY); const sy = startY < endY ? 1 : -1;
    let error = dx + dy;
    while (true) {
      setPixel(startX, startY, color);
      if (startX === endX && startY === endY) break;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; startX += sx; }
      if (twice <= dx) { error += dx; startY += sy; }
    }
  };
  const rectangle = (x, y, rectangleWidth, rectangleHeight, color) => {
    for (let py = Math.max(0, Math.round(y)); py < Math.min(height, Math.round(y + rectangleHeight)); py += 1) {
      for (let px = Math.max(0, Math.round(x)); px < Math.min(width, Math.round(x + rectangleWidth)); px += 1) setPixel(px, py, color);
    }
  };

  TIMEFRAMES.forEach((timeframe, panelIndex) => {
    const candles = [...(snapshot.candles && snapshot.candles[timeframe] || [])].slice(-CANDLES_PER_TIMEFRAME);
    const panelTop = panelIndex * panelHeight;
    const chartTop = panelTop + 8;
    const chartBottom = panelTop + panelHeight - 24;
    const volumeTop = chartBottom - 22;
    line(0, panelTop, width - 1, panelTop, [38, 49, 64]);
    for (let grid = 1; grid < 4; grid += 1) {
      const y = chartTop + ((chartBottom - chartTop) * grid) / 4;
      line(0, y, width - 1, y, [24, 31, 42]);
    }
    if (!candles.length) return;
    const low = Math.min(...candles.map((candle) => Number(candle.low)));
    const high = Math.max(...candles.map((candle) => Number(candle.high)));
    const priceRange = Math.max(Number.EPSILON, high - low);
    const maxVolume = Math.max(1, ...candles.map((candle) => Number(candle.volume) || 0));
    const step = width / candles.length;
    const priceY = (price) => chartTop + ((high - Number(price)) / priceRange) * (volumeTop - chartTop - 2);
    candles.forEach((candle, candleIndex) => {
      const x = candleIndex * step + step / 2;
      const rising = Number(candle.close) >= Number(candle.open);
      const color = rising ? [32, 201, 151] : [240, 79, 95];
      line(x, priceY(candle.high), x, priceY(candle.low), color);
      const openY = priceY(candle.open); const closeY = priceY(candle.close);
      const bodyWidth = Math.max(1, step * 0.58);
      rectangle(x - bodyWidth / 2, Math.min(openY, closeY), bodyWidth, Math.max(1, Math.abs(closeY - openY)), color);
      const volumeHeight = ((Number(candle.volume) || 0) / maxVolume) * 19;
      rectangle(x - bodyWidth / 2, chartBottom - volumeHeight, bodyWidth, volumeHeight, rising ? [19, 91, 73] : [105, 39, 49]);
    });
    const marker = [[95, 111, 255], [76, 201, 240], [227, 179, 65], [177, 75, 255], [138, 148, 163]][panelIndex];
    rectangle(0, panelTop + 1, 8, panelHeight - 2, marker);
  });

  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 3 + 1);
    raw[rowOffset] = 0;
    pixels.copy(raw, rowOffset + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 7 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function compactCandle(candle) {
  return [
    Number(candle.openTime), Number(candle.open), Number(candle.high), Number(candle.low),
    Number(candle.close), Number(candle.volume), Number(candle.closeTime),
  ];
}

function compactAnalysis(item) {
  if (!item) return null;
  return {
    timeframe: item.timeframe, closeTime: item.closeTime, price: item.price,
    trend: item.trend, momentum: item.momentum, structure: item.structure,
    volume: item.volume, regime: item.regime, volatility: item.volatility,
    rsi: item.rsi, atrPct: item.atrPct, volumeRatio: item.volumeRatio,
    rangePosition: item.rangePosition, distanceFromEma20Atr: item.distanceFromEma20Atr,
    trendStrengthPct: item.trendStrengthPct,
    triggers: (item.triggers || []).slice(-8).map((trigger) => ({
      type: trigger.type, direction: trigger.direction, timeframe: trigger.timeframe,
      strength: trigger.strength, closeTime: trigger.closeTime, detail: trigger.detail,
    })),
  };
}

function stableCandleMetadata(candles, timeframe) {
  const series = candles || [];
  const intervalMs = TIMEFRAME_MS[timeframe];
  return {
    count: series.length,
    firstOpenTime: series[0] && Number(series[0].openTime) || null,
    lastOpenTime: series[series.length - 1] && Number(series[series.length - 1].openTime) || null,
    lastCloseTime: series[series.length - 1] && Number(series[series.length - 1].closeTime) || null,
    intervalMs,
    continuous: series.every((candle, index) => index === 0
      || Number(candle.openTime) === Number(series[index - 1].openTime) + intervalMs),
  };
}

function buildMarketPayload({ symbol, snapshot, analyses, memory, analyzedAt }) {
  return {
    schemaVersion: 1,
    strategistVersion: STRATEGIST_VERSION,
    symbol,
    analyzedAt,
    candleArrayColumns: ['openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime'],
    timeframeOrderInImage: TIMEFRAMES,
    candles: Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe,
      (snapshot.candles && snapshot.candles[timeframe] || []).slice(-CANDLES_PER_TIMEFRAME).map(compactCandle),
    ])),
    metadata: Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe,
      stableCandleMetadata(snapshot.candles && snapshot.candles[timeframe] || [], timeframe),
    ])),
    analyses: Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe, compactAnalysis(analyses && analyses[timeframe])])),
    auditedMemory: memory,
  };
}

function exactKeys(value, expected, name) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) throw new Error(`${name} has unsupported or missing fields`);
}

function cleanString(value, name, maximum) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new Error(`${name} length is invalid`);
  return text;
}

function cleanStringArray(value, name, maximumItems = 8) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumItems) throw new Error(`${name} must contain 1-${maximumItems} items`);
  return value.map((item, index) => cleanString(item, `${name}[${index}]`, 280));
}

function validateDecision(value, horizon) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${horizon} decision must be an object`);
  exactKeys(value, ['verdict', 'confidence', 'thesis', 'evidence', 'risks', 'invalidation'], `${horizon} decision`);
  const verdict = cleanString(value.verdict, `${horizon}.verdict`, 4);
  if (!['UP', 'DOWN', 'WAIT'].includes(verdict)) throw new Error(`${horizon}.verdict is invalid`);
  const confidence = cleanString(value.confidence, `${horizon}.confidence`, 6);
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(confidence)) throw new Error(`${horizon}.confidence is invalid`);
  return {
    verdict,
    confidence,
    thesis: cleanString(value.thesis, `${horizon}.thesis`, 1_200),
    evidence: cleanStringArray(value.evidence, `${horizon}.evidence`),
    risks: cleanStringArray(value.risks, `${horizon}.risks`),
    invalidation: cleanString(value.invalidation, `${horizon}.invalidation`, 600),
  };
}

function validateLiveStrategy(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gemini live strategy must be an object');
  exactKeys(value, ['schemaVersion', 'symbol', 'candleCloseTime', 'marketRegime', 'decisions', 'memorySummary'], 'live strategy');
  if (value.schemaVersion !== 1) throw new Error('Gemini live strategy schemaVersion mismatch');
  if (value.symbol !== expected.symbol) throw new Error('Gemini live strategy symbol mismatch');
  if (!Number.isSafeInteger(expected.candleCloseTime) || !Number.isSafeInteger(value.candleCloseTime)
    || value.candleCloseTime !== expected.candleCloseTime) throw new Error('Gemini live strategy candleCloseTime mismatch');
  if (!value.decisions || typeof value.decisions !== 'object' || Array.isArray(value.decisions)) throw new Error('Gemini live strategy decisions must be an object');
  exactKeys(value.decisions, ['10m', '30m'], 'live strategy decisions');
  return {
    schemaVersion: 1,
    symbol: value.symbol,
    candleCloseTime: value.candleCloseTime,
    marketRegime: cleanString(value.marketRegime, 'marketRegime', 240),
    decisions: {
      '10m': validateDecision(value.decisions['10m'], '10m'),
      '30m': validateDecision(value.decisions['30m'], '30m'),
    },
    memorySummary: cleanString(value.memorySummary, 'memorySummary', 800),
  };
}

function applyAiConsensus(prediction, strategy, availableAt) {
  const deterministic = {
    action: prediction.action,
    direction: prediction.direction,
    verdict: prediction.verdict,
    reasonCodes: [...(prediction.reasonCodes || [])],
  };
  const horizonKey = `${prediction.horizonMin}m`;
  const decision = strategy && strategy.available && strategy.decisions ? strategy.decisions[horizonKey] : null;
  const deterministicEnter = prediction.action === 'ENTER' && ['UP', 'DOWN'].includes(prediction.direction);
  const agreed = Boolean(deterministicEnter && decision && decision.verdict === prediction.direction);
  let gateCode = null;
  let gateDetail = null;
  if (deterministicEnter && (!strategy || !strategy.available)) {
    gateCode = strategy && strategy.code || 'AI_UNAVAILABLE';
    gateDetail = strategy && strategy.error || 'strategul Gemini live nu este disponibil pentru această lumânare';
  } else if (deterministicEnter && decision && decision.verdict === 'WAIT') {
    gateCode = 'AI_WAIT';
    gateDetail = `Gemini a ales WAIT: ${decision.thesis}`;
  } else if (deterministicEnter && decision && decision.verdict !== prediction.direction) {
    gateCode = 'AI_DISAGREEMENT';
    gateDetail = `motor=${prediction.direction}, Gemini=${decision.verdict}`;
  } else if (!deterministicEnter && decision && ['UP', 'DOWN'].includes(decision.verdict)) {
    gateCode = 'AI_CANNOT_CREATE_SIGNAL';
    gateDetail = `Gemini=${decision.verdict}, dar porțile deterministe sunt WAIT`;
  }
  const timing = contractBoundaries(availableAt, prediction.horizonMin);
  const aiConsensus = {
    required: true,
    available: Boolean(strategy && strategy.available),
    agreed,
    code: agreed ? 'AI_DETERMINISTIC_AGREEMENT' : gateCode || 'DETERMINISTIC_WAIT',
    model: strategy && strategy.model || null,
    strategistVersion: strategy && strategy.strategistVersion || null,
    cacheKey: strategy && strategy.cacheKey || null,
    candleCloseTime: strategy && strategy.candleCloseTime || null,
    latencyMs: strategy && strategy.latencyMs || null,
    marketRegime: strategy && strategy.marketRegime || null,
    memorySummary: strategy && strategy.memorySummary || null,
    decision,
    error: strategy && strategy.error || null,
    deterministic,
  };
  if (agreed) {
    return {
      ...prediction,
      generatedAt: availableAt,
      entryBoundaryOpenTime: timing.entryOpenTime,
      expiryEstimateCloseTime: timing.expiryCloseTime,
      aiConsensus,
    };
  }
  const reasonCodes = [...new Set([...(prediction.reasonCodes || []), ...(gateCode ? [gateCode] : [])])];
  const gateChecks = [...(prediction.gateChecks || [])];
  const conflicts = [...(prediction.conflicts || [])];
  if (gateCode) {
    gateChecks.push({ code: gateCode, pass: false, detail: gateDetail });
    conflicts.push(gateDetail);
  }
  return {
    ...prediction,
    intendedDirection: prediction.direction || (decision && ['UP', 'DOWN'].includes(decision.verdict) ? decision.verdict : prediction.intendedDirection),
    action: 'WAIT',
    direction: null,
    verdict: 'WAIT',
    signalKey: null,
    reasonCodes,
    gateChecks,
    conflicts,
    generatedAt: availableAt,
    entryBoundaryOpenTime: timing.entryOpenTime,
    expiryEstimateCloseTime: timing.expiryCloseTime,
    aiConsensus,
  };
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['UP', 'DOWN', 'WAIT'] },
    confidence: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    thesis: { type: 'string' },
    evidence: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
    risks: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
    invalidation: { type: 'string' },
  },
  required: ['verdict', 'confidence', 'thesis', 'evidence', 'risks', 'invalidation'],
  additionalProperties: false,
};

const LIVE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    symbol: { type: 'string' },
    candleCloseTime: { type: 'integer' },
    marketRegime: { type: 'string' },
    decisions: {
      type: 'object',
      properties: { '10m': DECISION_SCHEMA, '30m': DECISION_SCHEMA },
      required: ['10m', '30m'],
      additionalProperties: false,
    },
    memorySummary: { type: 'string' },
  },
  required: ['schemaVersion', 'symbol', 'candleCloseTime', 'marketRegime', 'decisions', 'memorySummary'],
  additionalProperties: false,
};

class GeminiLiveStrategist {
  constructor({
    apiKey = process.env.GEMINI_API_KEY,
    model = process.env.GEMINI_LIVE_MODEL || process.env.GEMINI_MODEL || DEFAULT_LIVE_MODEL,
    fetchImpl = fetch,
    cacheLimit = 32,
  } = {}) {
    this.apiKey = apiKey || null;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.cacheLimit = cacheLimit;
    this.cache = new Map();
    this.symbolStatus = new Map();
    this.inFlight = 0;
    this.lastError = null;
    this.lastAnalyzedAt = null;
    this.lastSuccessfulAt = null;
    this.lastLatencyMs = null;
    this.totalRequests = 0;
  }

  updateSymbolStatus(symbol, update) {
    this.symbolStatus.set(symbol, { symbol, ...(this.symbolStatus.get(symbol) || {}), ...update });
    const statuses = [...this.symbolStatus.values()];
    const failures = statuses.filter((item) => item.lastError);
    this.lastError = failures.length ? failures.map((item) => `${item.symbol}: ${item.lastError}`).join(' | ') : null;
    const successes = statuses.map((item) => Number(item.lastSuccessfulAt)).filter(Number.isFinite);
    this.lastSuccessfulAt = successes.length ? Math.max(...successes) : null;
  }

  status() {
    return {
      enabled: Boolean(this.apiKey),
      requiredForEnter: true,
      model: this.model,
      strategistVersion: STRATEGIST_VERSION,
      role: 'multimodal live strategist; final ENTER requires exact agreement with deterministic gates',
      cadence: 'at most once per symbol per newly closed 1m candle',
      inFlight: this.inFlight,
      lastError: this.lastError,
      lastAnalyzedAt: this.lastAnalyzedAt,
      lastSuccessfulAt: this.lastSuccessfulAt,
      lastLatencyMs: this.lastLatencyMs,
      totalRequests: this.totalRequests,
      cacheSize: this.cache.size,
      bySymbol: Object.fromEntries([...this.symbolStatus.entries()].map(([symbol, item]) => [symbol, { ...item }])),
    };
  }

  trimCache() {
    while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
  }

  async analyze({ symbol, snapshot, analyses, memory, analyzedAt }, { timeoutMs = 15_000 } = {}) {
    const oneMinute = snapshot && snapshot.candles && snapshot.candles['1m'] || [];
    const candleCloseTime = oneMinute[oneMinute.length - 1] && Number(oneMinute[oneMinute.length - 1].closeTime);
    const cacheKey = `${STRATEGIST_VERSION}|${this.model}|${symbol}|${candleCloseTime}`;
    if (!this.apiKey) return { available: false, code: 'AI_DISABLED', cacheKey, model: this.model, candleCloseTime };
    if (!Number.isSafeInteger(candleCloseTime)) return { available: false, code: 'AI_INPUT_INVALID', cacheKey, model: this.model, candleCloseTime: null };
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const request = this.requestStrategy({ symbol, snapshot, analyses, memory, analyzedAt: candleCloseTime, candleCloseTime, cacheKey, timeoutMs });
    this.cache.set(cacheKey, request);
    this.trimCache();
    return request;
  }

  async requestStrategy({ symbol, snapshot, analyses, memory, analyzedAt, candleCloseTime, cacheKey, timeoutMs }) {
    this.inFlight += 1;
    this.totalRequests += 1;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const marketPayload = buildMarketPayload({ symbol, snapshot, analyses, memory, analyzedAt });
      const chartPng = renderChartPng(snapshot);
      const prompt = [
        'Ești strateg live disciplinat pentru Event Futures cu expirare exactă la 10 și 30 minute.',
        'Analizează independent seriile numerice OHLCV și imaginea multi-timeframe. Imaginea are, de sus în jos: 1m, 5m, 15m, 30m, 60m; bara colorată din stânga separă panourile.',
        'Pentru 10m prioritizează 1m+5m și folosește 15m ca context/veto. Pentru 30m prioritizează 5m+15m și folosește 30m+60m ca context/veto.',
        'Alege WAIT dacă datele sunt ambigue, conflictuale, extinse, prea volatile sau dacă memoria auditată nu susține setup-ul. Nu inventa niveluri sau certitudine.',
        'Nu știi verdictul motorului determinist și nu trebuie să-l ghicești. Verdictul tău va fi comparat ulterior în cod; numai acordul exact poate produce o recomandare manuală ENTER.',
        'Nu recomanda miză, martingale sau execuție automată. Returnează numai JSON conform schemei și echo exact symbol/candleCloseTime.',
        `Date numerice și memorie auditată: ${JSON.stringify(marketPayload)}`,
      ].join('\n');
      const response = await this.fetchImpl(`${BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/png', data: chartPng.toString('base64') } },
          ] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: LIVE_RESPONSE_SCHEMA,
          },
        }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 240)}`);
      const payload = JSON.parse(body);
      const text = payload && payload.candidates && payload.candidates[0]
        && payload.candidates[0].content && payload.candidates[0].content.parts
        && payload.candidates[0].content.parts.map((part) => part.text || '').join('');
      if (!text) throw new Error('Gemini returned no structured live strategy text');
      const strategy = validateLiveStrategy(JSON.parse(text), { symbol, candleCloseTime });
      const latencyMs = Date.now() - startedAt;
      const result = {
        available: true,
        code: 'AI_ANALYSIS_READY',
        cacheKey,
        model: this.model,
        strategistVersion: STRATEGIST_VERSION,
        latencyMs,
        analyzedAt: Date.now(),
        ...strategy,
      };
      this.lastAnalyzedAt = result.analyzedAt;
      this.lastLatencyMs = latencyMs;
      this.updateSymbolStatus(symbol, {
        available: true,
        candleCloseTime,
        lastError: null,
        lastAttemptAt: result.analyzedAt,
        lastSuccessfulAt: result.analyzedAt,
        lastLatencyMs: latencyMs,
      });
      return result;
    } catch (error) {
      const message = error.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : error.message;
      this.lastAnalyzedAt = Date.now();
      this.lastLatencyMs = Date.now() - startedAt;
      this.updateSymbolStatus(symbol, {
        available: false,
        candleCloseTime,
        lastError: message,
        lastAttemptAt: this.lastAnalyzedAt,
        lastLatencyMs: this.lastLatencyMs,
      });
      return {
        available: false,
        code: error.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_REQUEST_FAILED',
        error: message,
        cacheKey,
        model: this.model,
        candleCloseTime,
        latencyMs: this.lastLatencyMs,
        analyzedAt: this.lastAnalyzedAt,
      };
    } finally {
      clearTimeout(timer);
      this.inFlight -= 1;
    }
  }
}

module.exports = {
  GeminiLiveStrategist,
  DEFAULT_LIVE_MODEL,
  STRATEGIST_VERSION,
  TIMEFRAMES,
  renderChartPng,
  buildMarketPayload,
  validateLiveStrategy,
  applyAiConsensus,
  LIVE_RESPONSE_SCHEMA,
};
