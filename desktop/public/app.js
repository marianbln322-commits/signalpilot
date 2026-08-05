'use strict';

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]);
const safe = (value) => escapeHtml(value);
let currentConfig = null;
let currentJournalStats = null;
let currentForwardCalibration = null;
let currentBacktests = {};
let soundEnabled = true;
let configDirty = false;

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toLocaleString('ro-RO', { maximumFractionDigits: digits }) : '—';
}
function formatTime(value) { return Number.isFinite(value) ? new Date(value).toLocaleString('ro-RO') : '—'; }
function formatAge(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
function list(items, empty = '—') {
  const values = Array.isArray(items) && items.length ? items : [empty];
  return `<ul class="compact">${values.map((item) => `<li>${safe(item)}</li>`).join('')}</ul>`;
}
function metadataTable(metadata) {
  const rows = Object.entries(metadata || {}).map(([timeframe, item]) => `<tr>
    <td>${safe(timeframe)}</td><td>${safe(formatTime(item.lastOpenTime))}</td><td>${safe(formatTime(item.lastCloseTime))}</td>
    <td>${safe(formatAge(item.ageMs))} / limită ${safe(formatAge(item.freshnessLimitMs))}</td>
    <td class="${item.valid ? 'fresh' : 'stale'}">${safe(item.valid ? 'fresh · closed · continuu' : 'invalid/stale/gapped')}</td>
    <td>${safe(item.gaps ?? 0)} total / ${safe(item.gapsRecent ?? 0)} ultimele 100</td><td>${safe(item.source)}</td>
  </tr>`).join('');
  return `<table class="meta-table"><thead><tr><th>TF</th><th>last open</th><th>last close</th><th>age / limită</th><th>status</th><th>gaps</th><th>sursă</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function triggerText(trigger) {
  return trigger ? `${trigger.type} [${trigger.timeframe}] · ${trigger.direction} · ${trigger.detail} · close ${formatTime(trigger.closeTime)} · age ${formatAge(trigger.ageMs)}` : 'niciun trigger unic selectat';
}
function triggerCandidatesText(prediction) {
  return (prediction.triggerCandidates || []).map((trigger) => `${trigger.type} ${trigger.direction} [${trigger.timeframe}] · strength ${trigger.strength} · age ${formatAge(trigger.ageMs)}`);
}
function frameBiasText(prediction) {
  return (prediction.frameBiases || []).map((item) => `${item.timeframe}: ${item.state} (UP ${item.up} / DOWN ${item.down})`);
}
function qualityLedgerText(prediction) {
  return Object.entries(prediction.qualityComponents || {}).map(([name, value]) => `${name} ${value >= 0 ? '+' : ''}${formatNumber(value)}`);
}
function analysisSummary(analyses) {
  return Object.entries(analyses || {}).map(([timeframe, item]) => `${timeframe}: trend ${item.trend}, RSI ${formatNumber(item.rsi)}, MACD ${item.momentum}, ATR ${formatNumber(item.atrPct, 3)}%, volum ${formatNumber(item.volumeRatio)}x, range ${formatNumber(item.rangePosition, 3)}, structură ${item.structure}`).join(' | ');
}
function probabilityText(prediction) {
  const estimate = prediction.probabilityEstimate || { status: 'insufficient', n: 0 };
  if (estimate.status === 'not-estimated' || prediction.action === 'WAIT') return 'WAIT — probabilitatea nu se estimează';
  if (estimate.status === 'estimated') {
    const source = estimate.source === 'forward' ? 'forward real observat' : 'Binance proxy/in-sample';
    return `probabilitate istorică estimată (${source}) ${formatNumber(estimate.winRate, 1)}% · N=${estimate.n} · Wilson95 ${formatNumber(estimate.wilson95.low, 1)}–${formatNumber(estimate.wilson95.high, 1)}% · ${estimate.disclosure}`;
  }
  return `necalibrat — eșantion insuficient N=${estimate.n || 0} (forward ${estimate.forwardN || 0}, proxy ${estimate.backtestN || 0}); nu afișăm un procent inventat`;
}
function svgLine(yValue, y, width, pad, color, dash = '') {
  if (!Number.isFinite(yValue)) return '';
  return `<line x1="${safe(pad)}" y1="${safe(y(yValue).toFixed(2))}" x2="${safe(width - pad)}" y2="${safe(y(yValue).toFixed(2))}" stroke="${safe(color)}" ${dash ? `stroke-dasharray="${safe(dash)}"` : ''} opacity=".75"/>`;
}
function emaPolyline(visible, field, x, y, color) {
  const points = visible.map((candle, index) => Number.isFinite(candle[field]) ? `${x(index).toFixed(2)},${y(candle[field]).toFixed(2)}` : null).filter(Boolean);
  return points.length > 1 ? `<polyline points="${safe(points.join(' '))}" fill="none" stroke="${safe(color)}" stroke-width="1.2"/>` : '';
}
function directionBadge(label, value) {
  const visual = ['UP', 'DOWN'].includes(value) ? value : 'NEUTRAL';
  return `<span class="analysis-badge ${safe(visual)}">${safe(label)} ${safe(value ?? '—')}</span>`;
}
function candleChart(timeframe, chartState, trigger, analysis) {
  const visible = chartState && Array.isArray(chartState.candles) ? chartState.candles : [];
  if (!visible.length) return `<div class="chart-empty">${safe(timeframe)} · fără candles</div>`;
  const width = 620;
  const height = 190;
  const pad = 18;
  const overlayValues = chartState.overlay ? Object.values(chartState.overlay).filter(Number.isFinite) : [];
  const indicatorValues = visible.flatMap((candle) => [candle.ema9, candle.ema20, candle.ema50]).filter(Number.isFinite);
  const lowest = Math.min(...visible.map((candle) => candle.low), ...indicatorValues, ...overlayValues);
  const highest = Math.max(...visible.map((candle) => candle.high), ...indicatorValues, ...overlayValues);
  const priceRange = Math.max(Number.EPSILON, highest - lowest);
  const xStep = (width - pad * 2) / visible.length;
  const x = (index) => pad + index * xStep + xStep / 2;
  const y = (price) => pad + (highest - price) / priceRange * (height - pad * 2);
  const triggerEvents = Array.isArray(analysis && analysis.triggers) ? analysis.triggers : [];
  const candlesSvg = visible.map((candle, index) => {
    const center = x(index);
    const candleDirection = candle.close > candle.open ? 'UP' : candle.close < candle.open ? 'DOWN' : 'NEUTRAL';
    const color = candleDirection === 'UP' ? '#16c784' : candleDirection === 'DOWN' ? '#ea3943' : '#8b949e';
    const openY = y(candle.open);
    const closeY = y(candle.close);
    const events = triggerEvents.filter((item) => item.timeframe === timeframe && item.closeTime === candle.closeTime);
    const selected = trigger && trigger.timeframe === timeframe && trigger.closeTime === candle.closeTime;
    const eventMarkers = events.map((event, eventIndex) => {
      const isSelected = selected && trigger.type === event.type && trigger.direction === event.direction;
      const markerY = event.direction === 'UP' ? y(candle.low) + 6 + eventIndex * 5 : y(candle.high) - 6 - eventIndex * 5;
      return `<circle cx="${safe(center.toFixed(2))}" cy="${safe(markerY.toFixed(2))}" r="${isSelected ? '4.5' : '3'}" fill="${safe(event.direction === 'UP' ? '#16c784' : '#ea3943')}" stroke="${isSelected ? '#ffd166' : '#fff'}"><title>${safe(`${event.type} ${event.direction} · ${event.detail}`)}</title></circle>`;
    }).join('');
    const selectedLabel = selected ? `<text x="${safe(center.toFixed(2))}" y="${safe((y(candle.high) - 12).toFixed(2))}" text-anchor="middle" fill="#ffd166" font-size="8">TRIGGER ALES</text>` : '';
    return `<line x1="${safe(center.toFixed(2))}" y1="${safe(y(candle.high).toFixed(2))}" x2="${safe(center.toFixed(2))}" y2="${safe(y(candle.low).toFixed(2))}" stroke="${safe(color)}" stroke-width="1"/><rect x="${safe((center - Math.max(0.45, xStep * 0.3)).toFixed(2))}" y="${safe(Math.min(openY, closeY).toFixed(2))}" width="${safe(Math.max(0.9, xStep * 0.6).toFixed(2))}" height="${safe(Math.max(1, Math.abs(closeY - openY)).toFixed(2))}" fill="${safe(color)}"/>${eventMarkers}${selectedLabel}`;
  }).join('');
  const latest = visible[visible.length - 1];
  const overlay = chartState.overlay || {};
  const analysisBadges = analysis ? `<div class="analysis-badges">${directionBadge('trend', analysis.trend)}${directionBadge('momentum', analysis.momentum)}${directionBadge('structură', analysis.structure)}<span class="analysis-badge">RSI ${safe(formatNumber(analysis.rsi))}</span><span class="analysis-badge">volum ${safe(formatNumber(analysis.volumeRatio))}x</span><span class="analysis-badge">ATR ${safe(formatNumber(analysis.atrPct, 3))}%</span></div>` : '';
  return `<div class="chart"><div class="chart-label"><b>${safe(timeframe)}</b><span>${safe(chartState.displayedCount || visible.length)} afișate / ${safe(chartState.analysisCount || visible.length)} folosite · close ${safe(formatTime(latest.closeTime))}</span></div>
    ${analysisBadges}
    <div class="chart-legend"><span class="legend-close">ultimul close</span><span class="legend-e9">EMA9</span><span class="legend-e20">EMA20</span><span class="legend-e50">EMA50</span><span class="legend-range">range high/low</span><span class="legend-trigger">trigger UP/DOWN</span></div>
    <svg viewBox="0 0 ${safe(width)} ${safe(height)}" role="img" aria-label="${safe(`Grafic candles ${timeframe} cu EMA, range și trigger`)}">
      ${svgLine(overlay.rangeHigh, y, width, pad, '#8b949e', '2 3')}${svgLine(overlay.rangeLow, y, width, pad, '#8b949e', '2 3')}${svgLine(latest.close, y, width, pad, '#f0f3ff', '4 3')}
      ${emaPolyline(visible, 'ema9', x, y, '#ffd166')}${emaPolyline(visible, 'ema20', x, y, '#4cc9f0')}${emaPolyline(visible, 'ema50', x, y, '#b14bff')}${candlesSvg}
    </svg>
    <div class="chart-values">close ${safe(formatNumber(latest.close, 8))} · EMA9 ${safe(formatNumber(latest.ema9, 8))} · EMA20 ${safe(formatNumber(latest.ema20, 8))} · EMA50 ${safe(formatNumber(latest.ema50, 8))} · range ${safe(formatNumber(overlay.rangeLow, 8))}–${safe(formatNumber(overlay.rangeHigh, 8))}</div></div>`;
}
function horizonCharts(prediction, chartData) {
  const frames = prediction.horizonMin === 10 ? ['1m', '5m', '15m'] : ['5m', '15m', '30m', '60m'];
  const timeline = `<div class="decision-timeline"><span>ultimul close folosit <b>${safe(formatTime(prediction.latestClosedCandleTime))}</b></span><span>analiză publicată <b>${safe(formatTime(prediction.generatedAt))}</b></span><span>intrare posibilă <b>${safe(formatTime(prediction.entryBoundaryOpenTime))}</b></span><span>expirare <b>${safe(formatTime(prediction.expiryEstimateCloseTime))}</b></span><span class="fresh">candle în formare exclus</span></div>`;
  return `<div class="charts"><div class="chart-caption">Fereastra completă de 300 candles MEXC închise folosită de motor · intervale ${safe(frames.join(' · '))}</div>${timeline}${frames.map((timeframe) => candleChart(timeframe, chartData && chartData[timeframe], prediction.trigger, prediction.timeframeAnalyses && prediction.timeframeAnalyses[timeframe])).join('')}</div>`;
}
function gateTable(gates) {
  const rows = (gates || []).map((gate) => `<tr><td class="${gate.pass ? 'fresh' : 'stale'}">${safe(gate.pass ? 'PASS' : 'FAIL')}</td><td>${safe(gate.code)}</td><td>${safe(gate.detail)}</td></tr>`).join('');
  return `<table class="gate-table"><thead><tr><th>Gate</th><th>Cod</th><th>Detaliu</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function predictionCard(_symbol, prediction, chartData) {
  const direction = ['UP', 'DOWN'].includes(prediction.direction) ? prediction.direction : null;
  const action = prediction.action === 'ENTER' && direction ? 'ENTER' : 'WAIT';
  const visual = direction || 'WAIT';
  const bias = ['UP', 'DOWN', 'NEUTRAL'].includes(prediction.bias) ? prediction.bias : 'NEUTRAL';
  const decision = action === 'ENTER' ? `ENTER ${direction}` : 'WAIT — NU INTRA';
  const qualityContext = action === 'ENTER' ? 'confluență eligibilă' : 'confluență descriptivă, intrare blocată';
  const reasons = (prediction.reasonCodes || []).map((code) => `<span class="reason">${safe(code)}</span>`).join('');
  return `<article class="card ${safe(visual)}">
    <div class="card-top"><span class="horizon">Intrare ${safe(prediction.horizonMin)} minute</span><span class="quality">${safe(qualityContext)} <b>${safe(prediction.quality)}/100</b> · nu probabilitate</span></div>
    <div class="verdict ${safe(visual)}">${safe(decision)}</div><div class="bias-line">Context direcțional curent: <b class="${safe(bias)}">${safe(bias)}</b>. Numai textul ENTER este semnal.</div><div class="observed-rate">${safe(probabilityText(prediction))}</div><div class="reason-codes">${reasons}</div>
    ${horizonCharts(prediction, chartData)}
    <div class="details">
      <b>Context, nu semnal</b><span>${safe(bias)} · nu este instrucțiune cât timp scrie WAIT</span>
      <b>Scor UP/DOWN</b><span>UP ${safe(formatNumber(prediction.directionScores && prediction.directionScores.up))} / DOWN ${safe(formatNumber(prediction.directionScores && prediction.directionScores.down))} · agregat ${safe(prediction.directionScores && prediction.directionScores.aggregate || '—')} · marjă ${safe(formatNumber(prediction.directionScores && prediction.directionScores.margin))}</span>
      <b>Bias pe TF</b><span>${list(frameBiasText(prediction))}</span>
      <b>Trigger selectat</b><span>${safe(triggerText(prediction.trigger))}</span>
      <b>Candidați top</b><span>${list(triggerCandidatesText(prediction), 'niciun candidat top')}</span>
      <b>Selecție trigger</b><span>${safe(prediction.triggerSelection && prediction.triggerSelection.rule || '—')} · tie direcțional ${safe(prediction.triggerSelection && prediction.triggerSelection.directionTie ? 'DA — WAIT' : 'nu')}</span>
      <b>Trigger age</b><span>${safe(formatAge(prediction.triggerAgeMs))} / fereastră ${safe(formatAge(prediction.triggerWindowMs))}</span>
      <b>TF confirmă</b><span>${safe((prediction.confirmingTimeframes || []).join(', ') || '—')}</span>
      <b>TF opun</b><span>${safe((prediction.opposingTimeframes || []).join(', ') || '—')}</span>
      <b>Entry boundary</b><span>${safe(formatTime(prediction.entryBoundaryOpenTime))} · primul 1m open strict după generatedAt</span>
      <b>Expiry</b><span>${safe(formatTime(prediction.expiryEstimateCloseTime))} · closeTime exact al minutei finale</span>
      <b>Gate checks</b><span>${gateTable(prediction.gateChecks)}</span>
      <b>Ledger confluență</b><span>${list(qualityLedgerText(prediction))}</span>
      <b>Confirmări</b><span>${safe((prediction.confirmations || []).join(', ') || '—')}</span>
      <b>Dovezi</b><span>${list(prediction.evidence)}</span>
      <b>Conflicte</b><span>${list(prediction.conflicts, 'niciun conflict explicit')}</span>
      <b>Invalidare</b><span>${safe(prediction.invalidation)}</span>
      <b>Context</b><span>${safe(prediction.context)}</span>
      <b>Analize TF</b><span>${safe(analysisSummary(prediction.timeframeAnalyses))}</span>
      <b>generatedAt</b><span>${safe(formatTime(prediction.generatedAt))}</span>
      <b>Ultimul close</b><span>${safe(formatTime(prediction.latestClosedCandleTime))}</span>
      <b>Signal key</b><span>${safe(prediction.signalKey || '— (WAIT)')}</span>
    </div>
  </article>`;
}
function renderLatest(latest) {
  const entries = Object.entries(latest || {});
  byId('symbols').innerHTML = entries.length ? entries.map(([symbol, result]) => `<section class="symbol-group">
    <div class="symbol-head"><h3>${safe(symbol)}</h3><span class="muted">generatedAt ${safe(formatTime(result.generatedAt))} · ${safe(result.clockSource || result.source)} · skew ${safe(formatAge(Math.abs(result.clockSkewMs || 0)))} ${result.clockSkewMs < 0 ? 'în urmă' : 'înainte'}</span></div>
    <div class="prediction-grid">${predictionCard(symbol, result.predictions['10m'], result.chartData)}${predictionCard(symbol, result.predictions['30m'], result.chartData)}</div>
    ${metadataTable(result.metadata)}
  </section>`).join('') : '<p class="muted">Aștept primul scan complet valid; rezultatele vechi sunt eliminate la scan failure.</p>';
}
function aggregateBox(label, value) {
  const n = value && Number.isFinite(value.n) ? value.n : 0;
  const rate = value && value.winRate != null ? `${formatNumber(value.winRate, 1)}%` : '—';
  const ci = value && value.wilson95 && value.wilson95.low != null ? `${formatNumber(value.wilson95.low, 1)}–${formatNumber(value.wilson95.high, 1)}%` : '—';
  return `<div class="stat"><strong>${safe(rate)}</strong><span>${safe(label)} · N=${safe(n)} · wins=${safe(value ? value.wins : 0)} · Wilson95 ${safe(ci)}</span></div>`;
}
function renderJournal(journal) {
  const stats = journal && journal.stats;
  if (!stats) return;
  currentJournalStats = stats;
  currentForwardCalibration = journal.calibration;
  byId('journalStats').innerHTML = aggregateBox('overall', stats.overall)
    + aggregateBox('10m', stats.byHorizon['10m']) + aggregateBox('30m', stats.byHorizon['30m'])
    + aggregateBox('UP rezolvate', stats.byDirection.UP) + aggregateBox('DOWN rezolvate', stats.byDirection.DOWN)
    + `<div class="stat"><strong>${safe(stats.issuedByDirection ? stats.issuedByDirection.UP : 0)} / ${safe(stats.issuedByDirection ? stats.issuedByDirection.DOWN : 0)}</strong><span>ENTER emise UP / DOWN · fără țintă artificială 50/50</span></div>`
    + `<div class="stat"><strong>${safe(stats.pending)}</strong><span>pending · invalid excluse ${safe(stats.invalid)} · istoric alt motor exclus ${safe(stats.excludedOtherEngineVersions || 0)}</span></div>`;
  const rows = (journal.recent || []).map((entry) => {
    const result = entry.status === 'resolved' ? (entry.win ? 'WIN' : 'LOSS') : entry.status === 'invalid' ? `INVALID: ${entry.invalidReason}` : 'PENDING';
    return `<div class="jrow"><span><b>${safe(entry.symbol)}</b> · ${safe(entry.horizonMin)}m · <span class="${safe(entry.direction)}">${safe(entry.direction)}</span> · quality ${safe(entry.quality)}<br><span class="muted">entry ${safe(formatTime(entry.entryOpenTime))} ${safe(formatNumber(entry.entryPrice, 8))} → expiry ${safe(formatTime(entry.targetCloseTime))} ${safe(formatNumber(entry.exitPrice, 8))}</span></span><b>${safe(result)}</b></div>`;
  }).join('');
  byId('journalRows').innerHTML = rows || '<p class="muted">Niciun semnal deduplicat încă.</p>';
}
function alertRow(alert) {
  const direction = alert && alert.direction;
  if (!alert || alert.action !== 'ENTER' || !['UP', 'DOWN'].includes(direction)) return '';
  return `<div class="alert"><span><b>${safe(alert.symbol)}</b> · ${safe(alert.horizonMin)}m · <span class="${safe(direction)}">ENTER ${safe(direction)}</span> · confluență ${safe(alert.quality)} · ${safe(triggerText(alert.trigger))}</span><span class="muted">${safe(formatTime(alert.generatedAt))}</span></div>`;
}
function renderAlerts(alerts) {
  const validAlerts = (alerts || []).filter((alert) => alert && alert.action === 'ENTER' && ['UP', 'DOWN'].includes(alert.direction));
  byId('alerts').innerHTML = validAlerts.length ? validAlerts.map(alertRow).join('') : '<p class="muted">WAIT nu generează alertă. Aștept un ENTER care trece toate porțile.</p>';
}
function renderErrors(errors) {
  byId('scanErrors').innerHTML = Object.entries(errors || {}).map(([symbol, error]) => `<div>${safe(symbol)} · ${safe(formatTime(error.at))}: ${safe(error.message)} · rezultat vechi eliminat</div>`).join('');
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
function renderState(state) {
  if (state.config) fillConfig(state.config);
  currentBacktests = state.backtests || {};
  currentForwardCalibration = state.journal && state.journal.calibration;
  currentJournalStats = state.journal && state.journal.stats;
  renderLatest(state.latest);
  renderAlerts(state.alerts);
  renderJournal(state.journal);
  renderErrors(state.status && state.status.errors);
  const clock = state.status && state.status.scanClock;
  byId('clockBadge').textContent = clock ? (clock.failClosed ? 'Clock neverificat · fără ENTER' : `publicat ${formatTime(clock.publishedAtCorrected || clock.asOf)}`) : 'asOf —';
  byId('clockBadge').className = `badge ${clock && clock.failClosed ? 'badge-off' : ''}`;
  byId('sourceLine').textContent = clock ? `Build ${state.build || '—'} · Clock: ${clock.source} · skew ${clock.localSkewMs}ms · RTT ${clock.roundTripMs}ms${clock.warning ? ` · fallback: ${clock.warning}` : ''}` : `Build ${state.build || '—'} · aștept primul scan…`;
  const progress = state.status && state.status.backtestProgress;
  if (progress) byId('btStatus').textContent = `${progress.phase}: ${progress.percent}%`;
}
function beep() {
  if (!soundEnabled) return;
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain); gain.connect(context.destination); oscillator.frequency.value = 820;
    gain.gain.setValueAtTime(0.001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.3);
    oscillator.start(); oscillator.stop(context.currentTime + 0.3);
  } catch { /* browser audio can be unavailable */ }
}
async function loadState() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  renderState(await response.json());
}
async function saveConfig() {
  const body = {
    symbols: byId('cfgSymbols').value.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean),
    scanIntervalSec: Number(byId('cfgScan').value), settleDelayMs: Number(byId('cfgSettle').value),
    minQuality10: Number(byId('cfgQ10').value), minQuality30: Number(byId('cfgQ30').value),
    payout10: Number(byId('cfgP10').value), payout30: Number(byId('cfgP30').value),
  };
  byId('saveStatus').textContent = 'salvez…';
  const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  byId('saveStatus').textContent = response.ok ? 'salvat; scanner repornit' : `eroare: ${result.error}`;
  if (response.ok) {
    configDirty = false;
    fillConfig(result.config, true);
  }
}
function metric(label, value) { return aggregateBox(label, value || {}); }
function calibrationRows(calibration) {
  const buckets = calibration && calibration.buckets ? Object.values(calibration.buckets) : [];
  return buckets.length ? `<div class="calibration-grid">${buckets.map((bucket) => `<div><b>${safe(bucket.key)}</b> · ${safe(bucket.winRate)}% · N=${safe(bucket.n)} · Wilson95 ${safe(bucket.wilson95.low)}–${safe(bucket.wilson95.high)}%</div>`).join('')}</div>` : '<div class="muted">Fără bucket-uri calibrate.</div>';
}
async function runBacktest() {
  const symbol = byId('btSymbol').value;
  const days = byId('btDays').value;
  byId('btStatus').textContent = 'worker: descarc/replay event-time…'; byId('btResult').innerHTML = '';
  try {
    const response = await fetch('/api/backtest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, days: Number(days) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    currentBacktests[symbol] = result;
    byId('btStatus').textContent = `${result.evaluated} semnale evaluate din ${result.totalOneMinuteCandles} candles 1m`;
    byId('btResult').innerHTML = `<div class="bt-note"><b>${safe(result.source)}</b><br>${safe(result.proxyDisclosure)}<br>${safe(result.methodology)}<br>Coverage exact ${safe(formatTime(result.coverage.coverageStartOpenTime))}–${safe(formatTime(result.coverage.coverageEndCloseTime))}. Invalid intervals ${safe(result.integrity.invalidIntervals.length)}, snapshot-uri sărite ${safe(result.integrity.skippedInvalidSnapshots)}, boundary lipsă ${safe(result.integrity.skippedMissingBoundaries)}.<br>Opportunities 10m/30m: ${safe(result.opportunities['10m'])}/${safe(result.opportunities['30m'])}; signals: ${safe(result.signals['10m'])}/${safe(result.signals['30m'])}; WAIT coverage: ${safe(result.waitCoverage['10m'])}%/${safe(result.waitCoverage['30m'])}%.</div>
      <div class="stats">${metric('overall', result.overall)}${metric('10m', result.byHorizon['10m'])}${metric('30m', result.byHorizon['30m'])}${metric('UP', result.byDirection.UP)}${metric('DOWN', result.byDirection.DOWN)}</div>
      <div class="bt-note"><b>Calibrare Binance proxy/in-sample pe horizon + direction + quality band</b>${calibrationRows(result.calibration)}<br>Nu prezice sigur semnalul curent. Parametrii sunt fixați, nu adaptați pe setul evaluat.</div>`;
    renderLatest((await (await fetch('/api/state')).json()).latest);
  } catch (error) { byId('btStatus').textContent = `eroare: ${error.message}`; }
}

byId('saveConfig').addEventListener('click', saveConfig);
byId('runBacktest').addEventListener('click', runBacktest);
byId('clearAlerts').addEventListener('click', () => { byId('alerts').innerHTML = '<p class="muted">Flux golit doar în UI.</p>'; });
byId('soundToggle').addEventListener('change', (event) => { soundEnabled = event.target.checked; });
for (const id of ['cfgSymbols', 'cfgScan', 'cfgSettle', 'cfgQ10', 'cfgQ30', 'cfgP10', 'cfgP30']) {
  byId(id).addEventListener('input', () => { configDirty = true; });
}

const stream = new EventSource('/api/stream');
stream.addEventListener('open', () => { byId('connBadge').textContent = 'Live SSE'; byId('connBadge').className = 'badge badge-on'; });
stream.addEventListener('error', () => { byId('connBadge').textContent = 'Reconectare…'; byId('connBadge').className = 'badge badge-off'; });
stream.addEventListener('snapshot', (event) => renderState(JSON.parse(event.data)));
stream.addEventListener('scan-complete', (event) => {
  const state = JSON.parse(event.data);
  renderState(state);
  if (Array.isArray(state.newAlerts) && state.newAlerts.length > 0) beep();
});
stream.addEventListener('alert', (event) => {
  const alert = JSON.parse(event.data);
  const row = alertRow(alert);
  if (row) { byId('alerts').insertAdjacentHTML('afterbegin', row); beep(); }
});
stream.addEventListener('config', (event) => fillConfig(JSON.parse(event.data)));
stream.addEventListener('backtest-progress', (event) => { const progress = JSON.parse(event.data); byId('btStatus').textContent = `${progress.phase}: ${progress.percent}%`; });
loadState().catch((error) => { byId('scanErrors').textContent = error.message; });
