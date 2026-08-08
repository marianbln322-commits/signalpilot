'use strict';

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]);
const safe = (value) => escapeHtml(value);

let currentState = null;
let currentConfig = null;
let currentBacktests = {};
let currentTickers = {};
let soundEnabled = true;
let configDirty = false;
const selectedIntervals = {};

function isMissing(value) { return value === null || value === undefined || value === ''; }
function formatNumber(value, digits = 2) {
  if (isMissing(value)) return '—';
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('ro-RO', { maximumFractionDigits: digits }) : '—';
}
function formatPrice(value) {
  if (isMissing(value)) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const digits = number >= 1_000 ? 2 : number >= 10 ? 3 : 5;
  return number.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}
function formatTime(value, seconds = true) {
  if (isMissing(value)) return '—';
  return Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString('ro-RO', seconds ? { hour12: false } : undefined) : '—';
}
function formatAge(ms) {
  if (isMissing(ms) || !Number.isFinite(Number(ms))) return '—';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
function directionClass(value) { return ['UP', 'DOWN'].includes(value) ? value : 'NEUTRAL'; }
function compactList(items, empty = '—') {
  const values = Array.isArray(items) && items.length ? items : [empty];
  return `<ul class="compact">${values.map((item) => `<li>${safe(item)}</li>`).join('')}</ul>`;
}
function metric(label, value) {
  const n = value && Number.isFinite(value.n) ? value.n : 0;
  const rate = value && value.winRate != null ? `${formatNumber(value.winRate, 1)}%` : '—';
  const interval = value && value.wilson95 && value.wilson95.low != null
    ? `${formatNumber(value.wilson95.low, 1)}–${formatNumber(value.wilson95.high, 1)}%` : '—';
  return `<div class="stat"><strong>${safe(rate)}</strong><span>${safe(label)} · N=${safe(n)} · Wilson95 ${safe(interval)}</span></div>`;
}

function analysesFor(result) {
  const ten = result && result.predictions && result.predictions['10m'];
  const thirty = result && result.predictions && result.predictions['30m'];
  return { ...(ten && ten.timeframeAnalyses || {}), ...(thirty && thirty.timeframeAnalyses || {}) };
}

function analysisBalance(prediction) {
  const rawUp = prediction && prediction.directionScores && prediction.directionScores.up;
  const rawDown = prediction && prediction.directionScores && prediction.directionScores.down;
  if (rawUp === null || rawUp === undefined || rawDown === null || rawDown === undefined) return null;
  const up = Number(rawUp);
  const down = Number(rawDown);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up < 0 || down < 0) return null;
  const total = up + down;
  const noDirectionalEvidence = total === 0;
  const upPct = noDirectionalEvidence ? 50 : up / total * 100;
  const downPct = noDirectionalEvidence ? 50 : down / total * 100;
  const spread = Math.abs(upPct - downPct);
  const dominant = noDirectionalEvidence || spread < 8 ? 'NEUTRAL' : upPct > downPct ? 'UP' : 'DOWN';
  return {
    up,
    down,
    total,
    upPct,
    downPct,
    noDirectionalEvidence,
    dominant,
    label: noDirectionalEvidence ? 'NEUTRU · FĂRĂ DOVEZI' : dominant === 'UP' ? 'PRESIUNE UP' : dominant === 'DOWN' ? 'PRESIUNE DOWN' : 'ECHILIBRU',
  };
}

function analysisBalancePanel(result) {
  const predictions = result && result.predictions || {};
  const cards = ['10m', '30m'].map((horizon) => {
    const prediction = predictions[horizon];
    const balance = analysisBalance(prediction);
    const horizonLabel = horizon === '10m' ? 'ORIZONT DECIZIE 10 MINUTE' : 'ORIZONT DECIZIE 30 MINUTE';
    if (!prediction || !balance) {
      return `<div class="balance-card balance-NEUTRAL"><div class="balance-head"><strong>${safe(horizonLabel)} · ANALIZĂ INDISPONIBILĂ</strong></div><small>Lipsesc scorurile direcționale.</small></div>`;
    }
    const action = prediction.action === 'ENTER' && ['UP', 'DOWN'].includes(prediction.direction)
      ? `SEMNAL ENTER ${prediction.direction}`
      : 'WAIT · DOAR ANALIZĂ';
    const evidenceNote = balance.noDirectionalEvidence
      ? 'scor brut 0 / 0 · 50/50 este afișarea neutră convențională'
      : `scor brut UP ${formatNumber(balance.up, 2)} / DOWN ${formatNumber(balance.down, 2)} · bias ${prediction.bias || 'NEUTRAL'}`;
    return `<div class="balance-card balance-${safe(balance.dominant)}"><div class="balance-head"><strong>${safe(horizonLabel)} · ${safe(balance.label)}</strong><span>${safe(action)}</span></div><div class="balance-values"><b class="UP">UP ${safe(formatNumber(balance.upPct, 1))}%</b><b class="DOWN">DOWN ${safe(formatNumber(balance.downPct, 1))}%</b></div><svg class="balance-meter" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${safe(`Balanță orizont ${horizon}: UP ${formatNumber(balance.upPct, 1)}%, DOWN ${formatNumber(balance.downPct, 1)}%`)}"><rect x="0" y="0" width="100" height="8" rx="4" fill="#27303d"/><rect x="0" y="0" width="${safe(balance.upPct.toFixed(3))}" height="8" rx="4" fill="#20c997"/><rect x="${safe(balance.upPct.toFixed(3))}" y="0" width="${safe(balance.downPct.toFixed(3))}" height="8" rx="4" fill="#f04f5f"/></svg><small>${safe(evidenceNote)}</small></div>`;
  }).join('');
  return `<div class="analysis-balance"><div class="analysis-balance-title"><b>Încrederea analizei acum</b><span>balanță relativă a dovezilor, nu probabilitate de câștig</span></div><div class="balance-grid">${cards}</div></div>`;
}

function linePath(values, field, x, y) {
  const points = values.map((item, index) => Number.isFinite(item[field]) ? `${x(index).toFixed(2)},${y(item[field]).toFixed(2)}` : null).filter(Boolean);
  return points.length > 1 ? points.join(' ') : '';
}

function marketChart(symbol, result, timeframe, ticker) {
  const chart = result && result.chartData && result.chartData[timeframe];
  const allCandles = chart && Array.isArray(chart.candles) ? chart.candles : [];
  const candles = allCandles.slice(-90);
  if (!candles.length) return `<div class="chart-empty">${safe(timeframe)} · aștept lumânări validate</div>`;
  const analysis = analysesFor(result)[timeframe];
  const livePrice = ticker && Number(ticker.lastPrice);
  const width = 760;
  const height = 360;
  const left = 12;
  const right = 68;
  const top = 15;
  const priceBottom = 278;
  const volumeTop = 294;
  const volumeBottom = 345;
  const overlays = chart.overlay ? Object.values(chart.overlay).filter(Number.isFinite) : [];
  const indicatorValues = candles.flatMap((candle) => [candle.ema9, candle.ema20, candle.ema50]).filter(Number.isFinite);
  const liveValues = Number.isFinite(livePrice) ? [livePrice] : [];
  let low = Math.min(...candles.map((candle) => candle.low), ...indicatorValues, ...overlays, ...liveValues);
  let high = Math.max(...candles.map((candle) => candle.high), ...indicatorValues, ...overlays, ...liveValues);
  const padding = Math.max(Number.EPSILON, (high - low) * 0.06);
  low -= padding;
  high += padding;
  const range = Math.max(Number.EPSILON, high - low);
  const xStep = (width - left - right) / candles.length;
  const x = (index) => left + index * xStep + xStep / 2;
  const y = (price) => top + (high - price) / range * (priceBottom - top);
  const maxVolume = Math.max(1, ...candles.map((candle) => Number(candle.volume) || 0));
  const bars = candles.map((candle, index) => {
    const center = x(index);
    const rising = candle.close > candle.open;
    const falling = candle.close < candle.open;
    const color = rising ? '#16c784' : falling ? '#ea3943' : '#8b949e';
    const openY = y(candle.open);
    const closeY = y(candle.close);
    const bodyWidth = Math.max(1, xStep * 0.62);
    const volumeHeight = (Number(candle.volume) || 0) / maxVolume * (volumeBottom - volumeTop);
    return `<line x1="${center.toFixed(2)}" y1="${y(candle.high).toFixed(2)}" x2="${center.toFixed(2)}" y2="${y(candle.low).toFixed(2)}" stroke="${color}" stroke-width="1"/><rect x="${(center - bodyWidth / 2).toFixed(2)}" y="${Math.min(openY, closeY).toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${Math.max(1, Math.abs(closeY - openY)).toFixed(2)}" fill="${color}"/><rect x="${(center - bodyWidth / 2).toFixed(2)}" y="${(volumeBottom - volumeHeight).toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${volumeHeight.toFixed(2)}" fill="${color}" opacity=".34"/>`;
  }).join('');
  const ema9 = linePath(candles, 'ema9', x, y);
  const ema20 = linePath(candles, 'ema20', x, y);
  const ema50 = linePath(candles, 'ema50', x, y);
  const lastCandle = candles[candles.length - 1];
  const rangeHigh = chart.overlay && chart.overlay.rangeHigh;
  const rangeLow = chart.overlay && chart.overlay.rangeLow;
  const hasRangeHigh = Number.isFinite(rangeHigh);
  const hasRangeLow = Number.isFinite(rangeLow);
  const liveLine = Number.isFinite(livePrice) ? `<line x1="${left}" y1="${y(livePrice).toFixed(2)}" x2="${width - right}" y2="${y(livePrice).toFixed(2)}" stroke="#f5f7ff" stroke-width="1" stroke-dasharray="4 3"/><rect x="${width - right + 2}" y="${(y(livePrice) - 9).toFixed(2)}" width="64" height="18" rx="3" fill="#f5f7ff"/><text x="${width - right + 34}" y="${(y(livePrice) + 4).toFixed(2)}" text-anchor="middle" fill="#0d1117" font-size="10" font-weight="700">${safe(formatPrice(livePrice))}</text>` : '';
  const rangeLines = `${hasRangeHigh ? `<line x1="${left}" y1="${y(rangeHigh).toFixed(2)}" x2="${width - right}" y2="${y(rangeHigh).toFixed(2)}" stroke="#8a94a3" stroke-width="1" stroke-dasharray="3 4"/>` : ''}${hasRangeLow ? `<line x1="${left}" y1="${y(rangeLow).toFixed(2)}" x2="${width - right}" y2="${y(rangeLow).toFixed(2)}" stroke="#8a94a3" stroke-width="1" stroke-dasharray="3 4"/>` : ''}`;
  const rangeLabels = `${hasRangeHigh ? `<text x="${width - right - 4}" y="${Math.max(top + 10, y(rangeHigh) - 4).toFixed(2)}" text-anchor="end" fill="#aab3c0" font-size="9" font-weight="700">MAX50 ${safe(formatPrice(rangeHigh))}</text>` : ''}${hasRangeLow ? `<text x="${width - right - 4}" y="${Math.min(priceBottom - 4, y(rangeLow) + 11).toFixed(2)}" text-anchor="end" fill="#aab3c0" font-size="9" font-weight="700">MIN50 ${safe(formatPrice(rangeLow))}</text>` : ''}`;
  const badges = analysis ? `<div class="analysis-strip"><span class="${safe(directionClass(analysis.trend))}">trend ${safe(analysis.trend)}</span><span class="${safe(directionClass(analysis.momentum))}">momentum ${safe(analysis.momentum)}</span><span class="${safe(directionClass(analysis.structure))}">structură ${safe(analysis.structure)}</span><span>regim ${safe(analysis.regime)}</span><span>RSI ${safe(formatNumber(analysis.rsi))}</span><span>ATR ${safe(formatNumber(analysis.atrPct, 3))}%</span><span>volum ${safe(formatNumber(analysis.volumeRatio))}x</span></div>` : '';
  const technicalLegend = `<div class="chart-legend"><span class="legend-live">preț live 1s</span><span class="legend-e9">EMA9 ${safe(formatPrice(lastCandle.ema9))}</span><span class="legend-e20">EMA20 ${safe(formatPrice(lastCandle.ema20))}</span><span class="legend-e50">EMA50 ${safe(formatPrice(lastCandle.ema50))}</span>${hasRangeHigh ? `<span class="legend-range">MAX50 ${safe(formatPrice(rangeHigh))}</span>` : ''}${hasRangeLow ? `<span class="legend-range">MIN50 ${safe(formatPrice(rangeLow))}</span>` : ''}<span class="legend-volume">volum</span></div>`;
  return `<div class="pro-chart">${badges}${technicalLegend}<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${safe(`${symbol} ${timeframe}: lumânări MEXC, EMA9, EMA20, EMA50 și extremele ultimelor 50 de lumânări`)}">${rangeLines}${ema50 ? `<polyline points="${safe(ema50)}" fill="none" stroke="#b14bff" stroke-width="1.2"/>` : ''}${ema20 ? `<polyline points="${safe(ema20)}" fill="none" stroke="#4cc9f0" stroke-width="1.2"/>` : ''}${ema9 ? `<polyline points="${safe(ema9)}" fill="none" stroke="#ffd166" stroke-width="1.2"/>` : ''}${bars}${rangeLabels}${liveLine}<text x="${left}" y="356" fill="#77808f" font-size="9">${safe(formatTime(candles[0].openTime))}</text><text x="${width - right}" y="356" text-anchor="end" fill="#77808f" font-size="9">close ${safe(formatTime(lastCandle.closeTime))}</text></svg><div class="chart-foot">90 din ${safe(chart.analysisCount || allCandles.length)} lumânări închise · EMA din istoricul complet · MAX50/MIN50 sunt extreme tehnice, nu suport/rezistență garantată · linia albă este prețul live</div></div>`;
}

function renderMarkets() {
  if (!currentState) return;
  const configured = currentState.config && currentState.config.symbols || Object.keys(currentState.latest || {});
  byId('markets').innerHTML = configured.map((symbol) => {
    if (!selectedIntervals[symbol]) selectedIntervals[symbol] = '15m';
    const timeframe = selectedIntervals[symbol];
    const result = currentState.latest && currentState.latest[symbol];
    const observedTicker = currentTickers[symbol];
    const age = observedTicker ? Date.now() - observedTicker.receivedAt : null;
    const ticker = observedTicker && age <= 3_000 ? observedTicker : null;
    const change = ticker && Number(ticker.priceChangePercent);
    const changeClass = change > 0 ? 'UP' : change < 0 ? 'DOWN' : 'NEUTRAL';
    const tabs = ['1m', '5m', '15m', '30m', '60m'].map((interval) => `<button class="tf-button ${interval === timeframe ? 'active' : ''}" data-symbol="${safe(symbol)}" data-timeframe="${safe(interval)}">${safe(interval)}</button>`).join('');
    return `<article class="market-card"><div class="market-head"><div><h3>${safe(symbol.replace('USDT', '/USDT'))}</h3><div class="live-price">${safe(formatPrice(ticker && ticker.lastPrice))} <span class="${safe(changeClass)}">${Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${formatNumber(change, 2)}%` : '—'}</span></div></div><div class="ticker-meta"><span>bid ${safe(formatPrice(ticker && ticker.bidPrice))}</span><span>ask ${safe(formatPrice(ticker && ticker.askPrice))}</span><span>spread ${safe(formatNumber(ticker && ticker.spreadBps, 3))} bps</span><span class="${ticker && age <= 3_000 ? 'fresh' : 'stale'}">${ticker ? `update ${formatAge(age)} · RTT ${ticker.latencyMs}ms` : 'preț indisponibil'}</span></div></div>${analysisBalancePanel(result)}<div class="chart-controls-label"><b>Interval lumânări afișat:</b><span>separat de orizontul deciziei de mai sus</span></div><div class="tf-tabs" role="tablist" aria-label="Interval lumânări pentru graficul ${safe(symbol)}">${tabs}</div>${marketChart(symbol, result, timeframe, ticker)}</article>`;
  }).join('');
}

function probabilityText(prediction) {
  const estimate = prediction.probabilityEstimate || {};
  if (prediction.action === 'WAIT' || estimate.status === 'not-estimated') return 'Fără probabilitate pentru WAIT';
  if (estimate.status === 'estimated') return `${formatNumber(estimate.winRate, 1)}% observat · N=${estimate.n} · Wilson95 ${formatNumber(estimate.wilson95.low, 1)}–${formatNumber(estimate.wilson95.high, 1)}% · ${estimate.source === 'forward' ? 'forward' : 'proxy in-sample'}`;
  return `Necalibrat: N=${estimate.n || 0}; nu afișăm un procent inventat`;
}

function gatesTable(gates) {
  return `<table class="gate-table"><tbody>${(gates || []).map((gate) => `<tr><td class="${gate.pass ? 'fresh' : 'stale'}">${gate.pass ? 'PASS' : 'FAIL'}</td><td>${safe(gate.code)}</td><td>${safe(gate.detail)}</td></tr>`).join('')}</tbody></table>`;
}

function localLearningBlock(learning) {
  if (!learning || !learning.considered) {
    return '<div class="learner-box neutral"><b>Learner local:</b> motorul determinist este WAIT; learnerul nu poate crea o intrare.</div>';
  }
  const phase = learning.phase || 'WARMUP';
  const stateClass = learning.blocked ? 'blocked' : learning.active ? 'active' : 'neutral';
  const probability = learning.active && learning.probability != null
    ? ` · probabilitate model ${formatNumber(learning.probability * 100, 2)}% · prag ${formatNumber(learning.threshold * 100, 2)}%`
    : ' · modelul logistic complet nu este încă folosit';
  const eligibility = learning.trainingEligible ? 'eligibil pentru training' : `audit-only: ${learning.exclusionReason || 'overlap'}`;
  const circuit = learning.lossCircuit || {};
  const protection = learning.adaptiveProtection !== true
    ? 'instanța 3013: circuitul rapid este dezactivat; folosește 3014 pentru protecția în 3 trepte'
    : circuit.open
      ? `CIRCUIT DESCHIS · recovery shadow ${circuit.recoveryWins || 0}/${circuit.recoverySample || 0}`
      : `loss consecutive permise observate: ${learning.allowedLossStreak || 0}/3`;
  const reasons = (learning.blockReasons || []).map((reason) => `${reason.code}: ${reason.detail}`);
  return `<div class="learner-box ${safe(stateClass)}"><div class="learner-head"><b>Learner local · ${safe(phase)}</b><span>${safe(learning.blocked ? 'ENTER BLOCAT' : learning.active ? 'ENTER PĂSTRAT' : learning.adaptiveProtection ? 'PROTECȚIE RAPIDĂ ACTIVĂ' : 'LEARNER 3013')}</span></div><div>${safe(learning.bucketKey)} · N efectiv ${safe(learning.effectiveSamples)}/${safe(learning.minimumEffectiveSamples)} · W/L ${safe(learning.wins)}/${safe(learning.losses)}${safe(probability)}</div><div><b>Protecție:</b> ${safe(protection)}</div>${reasons.length ? `<div><b>Ce a corectat:</b>${compactList(reasons)}</div>` : ''}<p>${safe(eligibility)} · learnerul poate doar bloca, niciodată crea sau inversa semnale.</p></div>`;
}

function decisionCard(symbol, prediction) {
  const enter = prediction.action === 'ENTER' && ['UP', 'DOWN'].includes(prediction.direction);
  const visual = enter ? prediction.direction : 'WAIT';
  const title = enter ? `ENTER ${prediction.direction}` : 'WAIT — NU INTRA';
  const trigger = prediction.trigger ? `${prediction.trigger.type} ${prediction.trigger.direction} · ${prediction.trigger.timeframe} · ${prediction.trigger.detail}` : 'niciun trigger eligibil';
  const reasons = (prediction.reasonCodes || []).slice(0, 5).map((reason) => `<span class="reason">${safe(reason)}</span>`).join('');
  const frameRows = (prediction.frameBiases || []).map((frame) => `<span class="frame-chip ${safe(directionClass(frame.dominant))}">${safe(frame.timeframe)} ${safe(frame.state)} · ${safe(frame.up)}:${safe(frame.down)}</span>`).join('');
  const learning = prediction.localLearning;
  const balance = analysisBalance(prediction);
  const balanceText = balance
    ? `Balanță analiză: UP ${formatNumber(balance.upPct, 1)}% / DOWN ${formatNumber(balance.downPct, 1)}% (${balance.label.toLowerCase()})`
    : 'Balanță analiză indisponibilă';
  return `<article class="decision-card ${safe(visual)}"><div class="decision-top"><div><span class="symbol-label">${safe(symbol)}</span><h3>${safe(prediction.horizonMin)} minute</h3></div><span class="quality-ring">${safe(prediction.quality)}<small>/100</small></span></div><div class="decision-verdict ${safe(visual)}">${safe(title)}</div><p class="protocol">${safe(prediction.protocol)}</p><div class="frame-row">${frameRows}</div><div class="reason-codes">${reasons}</div><div class="decision-facts"><span>Bias <b class="${safe(directionClass(prediction.bias))}">${safe(prediction.bias)}</b></span><span>${safe(balanceText)} · scor relativ, nu probabilitate WIN</span><span>Trigger: ${safe(trigger)}</span><span>${safe(probabilityText(prediction))}</span></div>${localLearningBlock(learning)}<details class="audit"><summary>Audit complet al deciziei</summary><div class="audit-grid"><b>Execuție</b><span>${safe((prediction.executionTimeframes || []).join(' + '))}</span><b>Context</b><span>${safe((prediction.contextTimeframes || []).join(' + '))}</span><b>Confirmări</b><span>${safe((prediction.confirmations || []).join(', ') || '—')}</span><b>Dovezi</b><span>${compactList(prediction.evidence)}</span><b>Conflicte</b><span>${compactList(prediction.conflicts, 'niciun conflict explicit')}</span><b>Invalidare</b><span>${safe(prediction.invalidation)}</span><b>Entry</b><span>${safe(formatTime(prediction.entryBoundaryOpenTime))}</span><b>Expiry</b><span>${safe(formatTime(prediction.expiryEstimateCloseTime))}</span><b>Porți</b><span>${gatesTable(prediction.gateChecks)}</span><b>Signal key</b><span>${safe(prediction.signalKey || '—')}</span></div></details></article>`;
}

function renderDecisions() {
  const entries = Object.entries(currentState && currentState.latest || {});
  byId('decisions').innerHTML = entries.length ? entries.map(([symbol, result]) => `<section class="decision-symbol"><div class="decision-pair">${decisionCard(symbol, result.predictions['10m'])}${decisionCard(symbol, result.predictions['30m'])}</div></section>`).join('') : '<p class="muted">Aștept snapshot closed-candle complet și continuu.</p>';
}

function renderJournal(journal) {
  const stats = journal && journal.stats;
  if (!stats) return;
  byId('journalStats').innerHTML = metric('overall', stats.overall) + metric('10m', stats.byHorizon['10m']) + metric('30m', stats.byHorizon['30m']) + metric('UP', stats.byDirection.UP) + metric('DOWN', stats.byDirection.DOWN) + `<div class="stat"><strong>${safe(stats.pending)}</strong><span>pending · invalid ${safe(stats.invalid)} · alt motor exclus ${safe(stats.excludedOtherEngineVersions || 0)}</span></div>`;
  const learning = journal.learning || {};
  const setups = Object.values(learning.bySetup || {}).sort((a, b) => b.n - a.n).slice(0, 8);
  const tags = Object.entries(learning.lossTagCounts || {}).sort((a, b) => b[1] - a[1]);
  byId('learningSummary').innerHTML = `<div class="learning-policy"><b>Politică:</b> ${safe(learning.policy || '—')}<br><b>Break-even:</b> 10m ${safe(formatNumber(learning.breakEvenWinRate && learning.breakEvenWinRate['10m'], 2))}% · 30m ${safe(formatNumber(learning.breakEvenWinRate && learning.breakEvenWinRate['30m'], 2))}% · minimum calibrare N=${safe(learning.minimumSample || 30)}</div><div><b>Setup-uri observate</b>${setups.length ? compactList(setups.map((item) => `${item.key}: ${formatNumber(item.winRate, 1)}% · N=${item.n} · Wilson95 ${formatNumber(item.wilson95.low, 1)}–${formatNumber(item.wilson95.high, 1)}%`)) : '<p class="muted">Încă nu există setup-uri rezolvate în această versiune.</p>'}</div><div><b>Cauze candidate în pierderi</b>${tags.length ? compactList(tags.map(([tag, count]) => `${tag}: ${count}`)) : '<p class="muted">Nicio pierdere revizuită încă.</p>'}</div>`;
  const rows = (journal.recent || []).map((entry) => {
    const result = entry.status === 'resolved' ? (entry.win ? 'WIN' : 'LOSS') : entry.status === 'invalid' ? `INVALID · ${entry.invalidReason}` : 'PENDING';
    const review = entry.review;
    const local = entry.features && entry.features.localLearning;
    return `<article class="journal-row ${entry.win === false ? 'loss-row' : ''}"><div><b>${safe(entry.symbol)}</b> · ${safe(entry.horizonMin)}m · <span class="${safe(directionClass(entry.direction))}">${safe(entry.direction)}</span> · quality ${safe(entry.quality)}<div class="muted">${safe(formatTime(entry.entryOpenTime))} ${safe(formatPrice(entry.entryPrice))} → ${safe(formatTime(entry.targetCloseTime))} ${safe(formatPrice(entry.exitPrice))}</div>${review ? `<div class="review"><b>Review determinist:</b> ${safe(review.summary)}<br>MFE ${safe(formatNumber(review.maximumFavorableExcursionPct, 4))}% · MAE ${safe(formatNumber(review.maximumAdverseExcursionPct, 4))}% · ${safe((review.tags || []).join(', ') || 'fără tag')}</div>` : ''}${local ? `<div class="review"><b>Learner la emitere:</b> ${safe(local.bucketKey)} · ${safe(local.phase)} · N=${safe(local.effectiveSamples)}${local.active ? ` · p=${safe(formatNumber(local.probability * 100, 2))}% · prag=${safe(formatNumber(local.threshold * 100, 2))}%` : ''} · ${local.trainingEligible ? 'training eligibil' : 'audit-only overlap'}<br><b>Protecție la emitere:</b> ${local.lossCircuit && local.lossCircuit.open ? 'circuit deschis' : `loss streak ${safe(local.allowedLossStreak || 0)}/3`} · setup sample ${safe(local.setupGuard && local.setupGuard.sample || 0)}</div>` : ''}</div><strong class="${entry.win ? 'fresh' : entry.win === false ? 'stale' : ''}">${safe(result)}</strong></article>`;
  }).join('');
  byId('journalRows').innerHTML = rows || '<p class="muted">Niciun ENTER înregistrat pentru motorul curent.</p>';
}

function alertRow(alert) {
  if (!alert || alert.action !== 'ENTER' || !['UP', 'DOWN'].includes(alert.direction)) return '';
  return `<div class="alert"><span><b>${safe(alert.symbol)}</b> · ${safe(alert.horizonMin)}m · <span class="${safe(alert.direction)}">ENTER ${safe(alert.direction)}</span> · ${safe(alert.quality)}/100 · ${safe(alert.trigger && `${alert.trigger.type} ${alert.trigger.timeframe}` || 'trigger')}</span><time>${safe(formatTime(alert.generatedAt))}</time></div>`;
}
function renderAlerts(alerts) {
  const rows = (alerts || []).map(alertRow).filter(Boolean);
  byId('alerts').innerHTML = rows.length ? rows.join('') : '<p class="muted">WAIT nu generează alertă. Aștept un ENTER care trece toate porțile.</p>';
}
function renderErrors() {
  const scan = Object.entries(currentState && currentState.status && currentState.status.errors || {}).map(([symbol, error]) => `<div>${safe(symbol)} scan · ${safe(formatTime(error.at))}: ${safe(error.message)}</div>`);
  const ticker = Object.entries(currentState && currentState.tickerErrors || {}).map(([symbol, error]) => `<div>${safe(symbol)} live · ${safe(formatTime(error.at))}: ${safe(error.message)}</div>`);
  byId('scanErrors').innerHTML = [...scan, ...ticker].join('');
}

function fillConfig(config, force = false) {
  currentConfig = config;
  if (configDirty && !force) return;
  byId('cfgSymbols').value = (config.symbols || []).join('\n');
  byId('cfgScan').value = config.scanIntervalSec;
  byId('cfgSettle').value = config.settleDelayMs;
  byId('cfgQ10').value = config.minQuality10;
  byId('cfgQ30').value = config.minQuality30;
  byId('cfgP10').value = config.payout10;
  byId('cfgP30').value = config.payout30;
  byId('btSymbol').innerHTML = (config.symbols || []).map((symbol) => `<option value="${safe(symbol)}">${safe(symbol)}</option>`).join('');
}

function renderLocalLearning(learner) {
  const badge = byId('learnerBadge');
  const status = byId('learnerStatus');
  const buckets = Object.values(learner && learner.byBucket || {}).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.horizonMin - b.horizonMin);
  const unavailable = Boolean(learner && learner.available === false);
  const adaptiveProtection = Boolean(learner && learner.adaptiveProtection);
  const pausedCount = adaptiveProtection ? buckets.filter((bucket) => bucket.circuit && bucket.circuit.open).length : 0;
  const activeCount = buckets.filter((bucket) => bucket.active).length;
  const monitoringCount = buckets.filter((bucket) => bucket.phase === 'MONITORING').length;
  const globalPhase = unavailable ? 'ERROR' : pausedCount ? `PAUZĂ ${pausedCount}/4` : activeCount ? `ACTIVE ${activeCount}/4` : monitoringCount ? `MONITORING ${monitoringCount}/4` : 'WARMUP';
  badge.textContent = `Learner local · ${globalPhase}`;
  badge.className = `badge ${unavailable ? 'badge-off' : pausedCount ? '' : activeCount ? 'badge-on' : ''}`;
  status.textContent = unavailable
    ? `ERROR · ENTER blocat · ${learner.lastError || 'starea locală nu este disponibilă'}${learner.recovery ? ` · ${learner.recovery}` : ''}`
    : learner && learner.externalApi === false
      ? adaptiveProtection
        ? `${globalPhase} · cost API 0 · N efectiv ${learner.totals && learner.totals.effectiveSamples || 0} · protecție după ${learner.activation && learner.activation.lossStreakLimit || 3} loss`
        : `${globalPhase} · instanța 3013 · pentru circuit adaptiv pornește 3014`
      : 'Learner local indisponibil';
  status.className = `learner-status ${activeCount && !unavailable && !pausedCount ? 'enabled' : unavailable ? 'error' : ''}`;
  byId('localLearningSummary').innerHTML = buckets.length ? buckets.map((bucket) => {
    const circuit = bucket.circuit || {};
    const phaseClass = bucket.phase === 'ERROR' ? 'error' : circuit.open ? 'paused' : bucket.active ? 'active' : bucket.phase === 'MONITORING' ? 'monitoring' : 'warmup';
    const losses = bucket.modelLogLoss == null ? 'model mare: așteaptă rezultate' : `log-loss model ${formatNumber(bucket.modelLogLoss, 4)} / baseline ${formatNumber(bucket.baselineLogLoss, 4)} · ${bucket.beatsBaseline ? 'model mai bun' : 'încă nu bate baseline-ul'}`;
    const protection = !bucket.adaptiveProtection
      ? '3013: protecția rapidă este dezactivată; datele rămân separate de 3014'
      : circuit.open
        ? circuit.recoveryPossible === false
          ? `CIRCUIT DESCHIS · recovery imposibil la payout-ul curent: pragul cere ${safe(circuit.recoveryRequiredWins)}W din ${safe(circuit.recoveryRequiredSample)}`
          : `CIRCUIT DESCHIS · recovery ${safe(circuit.recoveryWins)}/${safe(circuit.recoverySample)}; necesar ${safe(circuit.recoveryRequiredWins)}W din ${safe(circuit.recoveryRequiredSample)}`
        : `streak ${safe(bucket.allowedLossStreak)}/${safe(bucket.lossStreakLimit)} · setup-uri blocate ${safe((bucket.weakSetups || []).length)}`;
    return `<article class="learner-bucket ${safe(phaseClass)}"><div><b>${safe(bucket.symbol)} · ${safe(bucket.horizonMin)}m</b><span>${safe(circuit.open ? 'PAUZĂ ADAPTIVĂ' : bucket.phase)}</span></div><strong>N ${safe(bucket.effectiveSamples)}/${safe(bucket.minimumEffectiveSamples)}</strong><p>W/L ${safe(bucket.wins)}/${safe(bucket.losses)} · pending ${safe(bucket.pending)} · overlap exclus ${safe(bucket.excludedOverlap)} · invalid ${safe(bucket.invalid)}</p><p><b>Protecție:</b> ${protection}</p><small>${safe(losses)}</small></article>`;
  }).join('') : '<p class="muted">Aștept inițializarea celor patru bucket-uri locale.</p>';
}

function renderState(state) {
  currentState = state;
  currentTickers = state.tickers || currentTickers;
  currentBacktests = state.backtests || {};
  if (state.config) fillConfig(state.config);
  renderMarkets();
  renderDecisions();
  renderJournal(state.journal);
  renderAlerts(state.alerts);
  renderErrors();
  renderLocalLearning(state.localLearning);
  const clock = state.status && state.status.scanClock;
  byId('clockBadge').textContent = clock ? (clock.failClosed ? 'Analiză blocată' : `Analiză ${formatAge(Date.now() - (clock.publishedAtCorrected || clock.asOf))}`) : 'Analiză —';
  byId('clockBadge').className = `badge ${clock && clock.failClosed ? 'badge-off' : ''}`;
  const newestTicker = Object.values(currentTickers).sort((a, b) => b.receivedAt - a.receivedAt)[0];
  byId('liveBadge').textContent = newestTicker ? `Preț live ${formatAge(Date.now() - newestTicker.receivedAt)}` : 'Preț live —';
  byId('liveBadge').className = `badge ${newestTicker && Date.now() - newestTicker.receivedAt <= 3_000 ? 'badge-on' : 'badge-off'}`;
  byId('sourceLine').textContent = `${state.endpoint || 'instanță locală'} · Build ${state.build || '—'} · preț MEXC Spot refresh 1s · analiză closed-candle ${state.config && state.config.scanIntervalSec || '—'}s · learner local ${state.localLearning && state.localLearning.available !== false ? 'persistent, API 0' : 'ERROR, ENTER blocat'}${clock ? ` · clock RTT ${clock.roundTripMs}ms · skew ${clock.localSkewMs}ms` : ''}`;
  const progress = state.status && state.status.backtestProgress;
  if (progress) byId('btStatus').textContent = `${progress.phase}: ${progress.percent}%`;
}

function refreshLiveFreshness() {
  if (!currentState) return;
  renderMarkets();
  const newestTicker = Object.values(currentTickers).sort((a, b) => b.receivedAt - a.receivedAt)[0];
  const fresh = newestTicker && Date.now() - newestTicker.receivedAt <= 3_000;
  byId('liveBadge').textContent = fresh ? `Preț live ${formatAge(Date.now() - newestTicker.receivedAt)}` : 'Preț live indisponibil';
  byId('liveBadge').className = `badge ${fresh ? 'badge-on' : 'badge-off'}`;
}

function beep() {
  if (!soundEnabled) return;
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain); gain.connect(context.destination); oscillator.frequency.value = 820;
    gain.gain.setValueAtTime(0.001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.28);
    oscillator.start(); oscillator.stop(context.currentTime + 0.3);
  } catch { /* audio may be unavailable */ }
}

async function loadState() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  renderState(await response.json());
}

async function saveConfig() {
  const body = {
    symbols: byId('cfgSymbols').value.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean),
    scanIntervalSec: Number(byId('cfgScan').value),
    settleDelayMs: Number(byId('cfgSettle').value),
    minQuality10: Number(byId('cfgQ10').value),
    minQuality30: Number(byId('cfgQ30').value),
    payout10: Number(byId('cfgP10').value),
    payout30: Number(byId('cfgP30').value),
  };
  byId('saveStatus').textContent = 'salvez…';
  const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  byId('saveStatus').textContent = response.ok ? 'salvat; scanner repornit' : `eroare: ${result.error}`;
  if (response.ok) { configDirty = false; fillConfig(result.config, true); }
}

function calibrationRows(calibration) {
  const buckets = calibration && calibration.buckets ? Object.values(calibration.buckets) : [];
  return buckets.length ? `<div class="calibration-grid">${buckets.map((bucket) => `<div><b>${safe(bucket.key)}</b> · ${safe(bucket.winRate)}% · N=${safe(bucket.n)} · Wilson95 ${safe(bucket.wilson95.low)}–${safe(bucket.wilson95.high)}%</div>`).join('')}</div>` : '<div class="muted">Fără bucket-uri calibrate.</div>';
}
async function runBacktest() {
  const symbol = byId('btSymbol').value;
  const days = Number(byId('btDays').value);
  byId('btStatus').textContent = 'descarc și rulez replay event-time…';
  byId('btResult').innerHTML = '';
  try {
    const response = await fetch('/api/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, days }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    currentBacktests[symbol] = result;
    byId('btStatus').textContent = `${result.evaluated} semnale evaluate`;
    byId('btResult').innerHTML = `<div class="bt-note">${safe(result.proxyDisclosure)}<br>${safe(result.methodology)}<br>Semnale 10m/30m: ${safe(result.signals['10m'])}/${safe(result.signals['30m'])}; WAIT ${safe(result.waitCoverage['10m'])}%/${safe(result.waitCoverage['30m'])}%.</div><div class="stats">${metric('overall', result.overall)}${metric('10m', result.byHorizon['10m'])}${metric('30m', result.byHorizon['30m'])}${metric('UP', result.byDirection.UP)}${metric('DOWN', result.byDirection.DOWN)}</div><div class="bt-note"><b>Bucket-uri proxy/in-sample</b>${calibrationRows(result.calibration)}</div>`;
  } catch (error) { byId('btStatus').textContent = `eroare: ${error.message}`; }
}

byId('markets').addEventListener('click', (event) => {
  const button = event.target.closest('.tf-button');
  if (!button) return;
  selectedIntervals[button.dataset.symbol] = button.dataset.timeframe;
  renderMarkets();
});
byId('saveConfig').addEventListener('click', saveConfig);
byId('runBacktest').addEventListener('click', runBacktest);
byId('clearAlerts').addEventListener('click', () => { byId('alerts').innerHTML = '<p class="muted">Flux golit doar local.</p>'; });
byId('soundToggle').addEventListener('change', (event) => { soundEnabled = event.target.checked; });
for (const id of ['cfgSymbols', 'cfgScan', 'cfgSettle', 'cfgQ10', 'cfgQ30', 'cfgP10', 'cfgP30']) byId(id).addEventListener('input', () => { configDirty = true; });

const stream = new EventSource('/api/stream');
stream.addEventListener('open', () => { byId('connBadge').textContent = 'SSE conectat'; byId('connBadge').className = 'badge badge-on'; });
stream.addEventListener('error', () => {
  currentTickers = {};
  if (currentState) currentState.tickers = {};
  refreshLiveFreshness();
  byId('connBadge').textContent = 'Reconectare…';
  byId('connBadge').className = 'badge badge-off';
});
stream.addEventListener('snapshot', (event) => renderState(JSON.parse(event.data)));
stream.addEventListener('scan-complete', (event) => {
  const state = JSON.parse(event.data);
  renderState(state);
  if (Array.isArray(state.newAlerts) && state.newAlerts.length) beep();
});
stream.addEventListener('price-tick', (event) => {
  const update = JSON.parse(event.data);
  currentTickers = update.tickers || currentTickers;
  if (currentState) {
    currentState.tickers = currentTickers;
    currentState.tickerErrors = update.errors || {};
    currentState.liveFeed = update.liveFeed;
    renderMarkets();
    renderErrors();
    const newest = Object.values(currentTickers).sort((a, b) => b.receivedAt - a.receivedAt)[0];
    byId('liveBadge').textContent = newest ? `Preț live ${formatAge(Date.now() - newest.receivedAt)}` : 'Preț live —';
    byId('liveBadge').className = `badge ${newest && Date.now() - newest.receivedAt <= 3_000 ? 'badge-on' : 'badge-off'}`;
  }
});
stream.addEventListener('config', (event) => fillConfig(JSON.parse(event.data)));
stream.addEventListener('backtest-progress', (event) => { const progress = JSON.parse(event.data); byId('btStatus').textContent = `${progress.phase}: ${progress.percent}%`; });
setInterval(refreshLiveFreshness, 1_000);
loadState().catch((error) => { byId('scanErrors').textContent = error.message; });
