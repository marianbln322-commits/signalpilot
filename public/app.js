'use strict';

// SignalPilot frontend: subscribes to SSE, renders live cards + alerts,
// handles settings save, AI key test, and backtest.

const $ = (id) => document.getElementById(id);
const cardsEl = $('cards');
const alertsEl = $('alerts');
let cards = {}; // symbol -> element
let soundOn = true;
let SNIPER_MODE = false; // set from server config on load
let CONTINUOUS_MODE = true;
let ACTIVE_SYMBOLS = [];
let ACTIVE_HOURS = Array.from({ length: 24 }, (_, hour) => hour); // UTC, set from config
const detailsOpen = {}; // per-symbol: keep the analysis panel open across live re-renders

function updateSessionBadge() {
  const el = $('sessionBadge');
  if (!el) return;
  if (CONTINUOUS_MODE) {
    el.textContent = '🟢 Monitorizare 24/7';
    el.className = 'badge badge-on';
    return;
  }
  const nowUtc = new Date().getUTCHours();
  const active = ACTIVE_HOURS.includes(nowUtc);
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
  const execForecast = v.forecasts && v.execution ? v.forecasts[v.execution.horizon] : null;
  if (execForecast && execForecast.technique) {
    const t = execForecast.technique;
    const cls = t.verdict === 'solid' ? 'ok' : t.verdict === 'slab' ? 'bad' : '';
    parts.push(`<span title="auto-ajustare din rezultatele tale">🛠 tehnică: <span class="${cls}">${t.verdict}</span>${t.n ? ` (${t.winRate}% / ${t.n})` : ''}</span>`);
  }
  if (v.suppressed) parts.push(`<span class="bad">⛔ blocat: ${v.suppressed}</span>`);
  const missingFrames = Object.keys(v.dataErrors || {});
  if (missingFrames.length) parts.push(`<span class="bad">⚠️ feed parțial: ${missingFrames.join(', ')}</span>`);
  if (!parts.length) return '';
  return `<div class="of-row">${parts.join(' &nbsp;·&nbsp; ')}</div>`;
}

function forecastGrid(v) {
  const forecasts = v.forecasts || {};
  const card = (horizon) => {
    const forecast = forecasts[horizon];
    if (!forecast) return '';
    const dir = forecast.directie.toLowerCase();
    const calibrated = forecast.calibrated && Number.isFinite(forecast.probabilityUp) && Number.isFinite(forecast.probabilityDown);
    const upValue = calibrated ? forecast.probabilityUp : forecast.technicalScoreUp;
    const downValue = calibrated ? forecast.probabilityDown : forecast.technicalScoreDown;
    const up = (Number.isFinite(upValue) ? upValue * 100 : 50).toFixed(1);
    const down = (Number.isFinite(downValue) ? downValue * 100 : 50).toFixed(1);
    const directionalValue = forecast.directie === 'UP' ? upValue : forecast.directie === 'DOWN' ? downValue : 0.5;
    const directionalScore = (Number.isFinite(directionalValue) ? directionalValue * 100 : 50).toFixed(1);
    const metricLabel = calibrated ? 'PROBABILITATE CALIBRATĂ' : 'SCOR TEHNIC';
    const action = forecast.action === 'TRADE' ? 'TRADE' : forecast.action === 'PAPER' ? 'PAPER' : 'WAIT';
    const progress = Number.isInteger(forecast.calibrationRequired)
      ? `<div class="forecast-progress">Calibrare validare: <b>${forecast.calibrationSampleSize || 0}/${forecast.calibrationRequired}</b> rezultate exacte${forecast.calibrationRemaining ? ` · lipsesc ${forecast.calibrationRemaining}` : ' · complet'}</div>`
      : '';
    return `<div class="forecast ${dir}">
      <div class="forecast-head"><b>${horizon} MINUTE</b><span class="forecast-action ${action.toLowerCase()}">${action}</span></div>
      <div class="forecast-direction ${dir}">${forecast.directie} <small>${directionalScore}%</small></div>
      <div class="forecast-learned">${calibrated ? '🧠' : '📐'} ${metricLabel}</div>
      <div class="prob-track"><i class="prob-down" style="width:${down}%"></i><i class="prob-up" style="width:${up}%"></i></div>
      <div class="forecast-probs"><span>DOWN ${down}%</span><span>UP ${up}%</span></div>
      <div class="forecast-tfs">Analiză: ${(forecast.timeframes || []).join(' · ')}${forecast.requiredProbability ? ` · prag ${(forecast.requiredProbability * 100).toFixed(1)}%` : ''}</div>
      ${progress}
      ${calibrated && Number.isFinite(forecast.reliabilityLowerBound) ? `<div class="forecast-learned">Limită conservatoare 90%: ${(forecast.reliabilityLowerBound * 100).toFixed(1)}%</div>` : ''}
      ${forecast.suppressed ? `<div class="forecast-suppressed">⛔ ${forecast.suppressed}</div>` : ''}
      <ul>${(forecast.reasons || []).slice(0, 4).map((reason) => `<li>${reason}</li>`).join('')}</ul>
    </div>`;
  };
  return `<div class="forecast-grid">${card(10)}${card(30)}</div>`;
}

function liveCharts(v) {
  const charts = v.charts || (v.chart ? { '1m': v.chart } : {});
  const ordered = ['1m', '3m', '5m', '15m', '30m'].filter((timeframe) => Array.isArray(charts[timeframe]) && charts[timeframe].length > 1);
  return `<div class="market-chart-grid">${ordered.map((timeframe) => `
    <div class="market-chart-panel">
      <div class="chart-label"><span>MEXC ${timeframe}${timeframe === '3m' ? ' · agregat din 1m' : ''}</span><span>live</span></div>
      <canvas class="candle-chart" data-chart-tf="${timeframe}" aria-label="Grafic MEXC ${timeframe}"></canvas>
    </div>`).join('')}</div>`;
}

function drawCandles(canvas, candles) {
  if (!canvas || !Array.isArray(candles) || candles.length < 2) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;
  const pad = { left: 8, right: 58, top: 12, bottom: 18 };
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const range = Math.max(max - min, max * 0.0001);
  const high = max + range * 0.08;
  const low = min - range * 0.08;
  const chartHeight = height - pad.top - pad.bottom;
  const y = (price) => pad.top + (high - price) / (high - low) * chartHeight;
  const step = (width - pad.left - pad.right) / candles.length;
  const bodyWidth = Math.max(1.5, Math.min(5, step * 0.65));

  ctx.clearRect(0, 0, width, height);
  ctx.font = '9px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let line = 0; line <= 4; line++) {
    const price = high - (high - low) * line / 4;
    const lineY = pad.top + chartHeight * line / 4;
    ctx.strokeStyle = '#2a3240';
    ctx.beginPath(); ctx.moveTo(pad.left, lineY); ctx.lineTo(width - pad.right + 5, lineY); ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.fillText(fmt(price), width - pad.right + 9, lineY);
  }
  candles.forEach((candle, index) => {
    const x = pad.left + step * index + step / 2;
    const rising = candle.close >= candle.open;
    const color = rising ? '#16c784' : '#ea3943';
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(x, y(candle.high)); ctx.lineTo(x, y(candle.low)); ctx.stroke();
    ctx.fillStyle = color;
    const top = y(Math.max(candle.open, candle.close));
    const bottom = y(Math.min(candle.open, candle.close));
    ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1.2, bottom - top));
  });
}

function renderCard(v) {
  const dir = v.directie.toLowerCase();
  const eligible = v.sniper && v.sniper.eligible;
  const sigs = (v.signals || []).slice(0, 5).map((s) => `<li>${s.label} <span class="muted">[${s.tf}]</span></li>`).join('');
  const ai = v.ai
    ? `<div class="ai-note">🤖 <b>AI (${v.ai.acord || '—'})</b>: ${v.ai.risc ? '⚠️ ' + v.ai.risc : ''} ${v.ai.comentariu || ''}</div>`
    : (v.aiError ? `<div class="ai-note">🤖 AI indisponibil: ${v.aiError}</div>` : '');

  // The BIG banner: the only thing you act on. Sniper Mode = trade only on 🎯.
  const ev = v.ev;
  const payoutNow = ev ? (v.interval === '10 minute' ? ev.payout10 : ev.payout30) : null;
  const beNow = ev ? (v.interval === '10 minute' ? ev.breakEven10 : ev.breakEven30) : null;
  const evWarn = ev && !ev.positive;
  const evNote = ev ? ` · payout ${payoutNow}% (break-even ${beNow}%)` : '';
  const warnLine = evWarn ? `<div class="ev-warn">⚠️ payout prea mic pentru edge-ul tău — EV negativ, mai bine sari peste</div>` : '';
  const chosenHorizon = v.execution ? v.execution.horizon : (v.interval === '10 minute' ? 10 : 30);
  const executionForecast = v.forecasts && v.forecasts[chosenHorizon];
  const executionAction = v.execution
    ? (v.execution.directie === v.directie ? v.execution.action : 'WAIT')
    : executionForecast && executionForecast.directie === v.directie ? executionForecast.action : 'WAIT';
  const forecastAllowsTrade = executionAction === 'TRADE';
  const forecastAllowsPaper = executionAction === 'PAPER';
  const waitReason = v.execution && v.execution.reason
    ? v.execution.reason
    : executionForecast
      ? `${chosenHorizon}m ${executionForecast.action}${executionForecast.suppressed ? ` · ${executionForecast.suppressed}` : ''}`
      : `forecast ${chosenHorizon}m indisponibil`;
  const calibrationNote = v.execution && Number.isInteger(v.execution.calibrationRequired)
    ? ` · validare ${v.execution.calibrationSampleSize || 0}/${v.execution.calibrationRequired}`
    : '';
  const paperBanner = `<div class="cta paper ${dir}">📝 SEMNAL TEHNIC ${v.directie} ${v.directie === 'UP' ? '▲' : '▼'}<div class="cta-sub">PAPER · fereastră ${v.interval}${evNote}${calibrationNote} · încă nevalidat statistic</div></div>${warnLine}`;
  let banner;
  if (SNIPER_MODE && !eligible) {
    banner = `<div class="cta wait">⏳ AȘTEAPTĂ<div class="cta-sub">nu e încă setup A+: ${v.sniper ? v.sniper.reason : '—'}</div></div>`;
  } else if (forecastAllowsTrade) {
    banner = `<div class="cta go ${dir}">${SNIPER_MODE ? '🎯 INTRĂ ' : ''}${v.directie} ${v.directie === 'UP' ? '▲' : v.directie === 'DOWN' ? '▼' : ''}<div class="cta-sub">TRADE VALIDAT · fereastră ${v.interval}${evNote} · încredere ${v.incredere}</div></div>${warnLine}`;
  } else if (forecastAllowsPaper) {
    banner = paperBanner;
  } else {
    banner = `<div class="cta wait">⏳ AȘTEAPTĂ<div class="cta-sub">${waitReason}</div></div>`;
  }

  return `
    <div class="card-top">
      <span class="card-sym">${v.symbol}</span>
      <span class="card-price">${fmt(v.price)} USDT</span>
    </div>
    ${liveCharts(v)}
    ${forecastGrid(v)}
    ${banner}
    ${ofRow(v)}
    <details class="analysis" data-sym="${v.symbol}" ${detailsOpen[v.symbol] ? 'open' : ''}>
      <summary>Analiza motorului în timp real (context, nu semnal de intrare)</summary>
      <div class="row5">
        <b>Direcție motor</b><span class="dir-inline ${dir}">${v.directie} · ${v.interval}</span>
        <b>Încredere</b><span><span class="pill ${v.incredere}">${v.incredere}</span> <span class="muted">(net ${v.scores.net})</span></span>
        <b>Justificare</b><span>${v.justificare}</span>
        <b>Invalidare</b><span>${v.invalidare}</span>
        ${ev ? `<b>EV / fereastră</b><span>10 min: <span class="${ev.ev10 > 0 ? 'dir-inline up' : 'dir-inline down'}">${ev.ev10 > 0 ? '+' : ''}${ev.ev10}%</span> (payout ${ev.payout10}%, nevoie ${ev.breakEven10}%) · 30 min: <span class="${ev.ev30 > 0 ? 'dir-inline up' : 'dir-inline down'}">${ev.ev30 > 0 ? '+' : ''}${ev.ev30}%</span> (payout ${ev.payout30}%, nevoie ${ev.breakEven30}%)</span>` : ''}
      </div>
      ${sigs ? `<ul class="sig-list">${sigs}</ul>` : ''}
      ${ai}
      <div class="snap">${snapChips(v.snapshots)}</div>
    </details>
    <div class="muted" style="margin-top:8px;font-size:11px">sursă: ${v.marketData ? v.marketData.source : 'MEXC'} · grafice actualizate ${new Date(v.marketData ? v.marketData.fetchedAt : v.ts).toLocaleTimeString('ro-RO')} · analiză pe lumânări închise · scan ${v.marketData ? v.marketData.scanIntervalSec : '—'}s</div>
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
  requestAnimationFrame(() => {
    const chartData = v.charts || (v.chart ? { '1m': v.chart } : {});
    el.querySelectorAll('.candle-chart').forEach((canvas) => {
      drawCandles(canvas, chartData[canvas.dataset.chartTf] || []);
    });
  });
  // Persist the analysis panel's open/closed state across live re-renders.
  const det = el.querySelector('details.analysis');
  if (det) {
    det.addEventListener('toggle', () => { detailsOpen[v.symbol] = det.open; });
  }
}

function alertBadge(a) {
  return a.action === 'TRADE'
    ? '<span class="tag validated">TRADE VALIDAT</span>'
    : '<span class="tag paper">PAPER tehnic</span>';
}

function alertRow(a) {
  const dir = a.directie.toLowerCase();
  return `
    <span class="adir ${dir}">${a.sniper ? '🎯 ' : ''}${a.directie} ${a.directie === 'UP' ? '▲' : '▼'}</span>
    <span><b>${a.symbol}</b> · ${a.interval} · ${alertBadge(a)} · <span class="pill ${a.incredere}">${a.incredere}</span> @ ${fmt(a.price)}</span>
    <span class="alert-time">${new Date(a.ts).toLocaleTimeString('ro-RO')}</span>
  `;
}

function addAlert(a) {
  if (alertsEl.querySelector('.muted')) alertsEl.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'alert-item flash';
  el.innerHTML = alertRow(a);
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
      el.innerHTML = alertRow(a);
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
function cohortProgressHtml(l) {
  const cohorts = (l.cohorts || []).filter((c) => c.n > 0 || c.pending > 0 || ACTIVE_SYMBOLS.includes(c.symbol));
  if (!cohorts.length) return '';
  const rows = cohorts
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))
    .map((c) => {
      const pct = Math.min(100, Math.round((c.n / c.required) * 100));
      const state = c.ready
        ? `<span class="ok">validare activă · ${c.winRate}%</span>`
        : `<span class="muted">${c.n}/${c.required}</span>`;
      return `<div class="lrow">
        <span>${c.symbol} ${c.directie} ${c.interval}</span>
        <span><span class="cohort-bar"><i style="width:${pct}%"></i></span> ${state}${c.pending ? ` <span class="muted">(+${c.pending} în curs)</span>` : ''}</span>
      </div>`;
    }).join('');
  return `<div class="learn-h">📊 Progres validare per monedă + direcție + fereastră</div>${rows}
    <p class="muted" style="margin-top:8px">Semnalele PAPER apar imediat din analiza tehnică. TRADE VALIDAT apare numai când o cohortă atinge ${l.minSample || 30} rezultate exacte și trece pragurile de calitate.</p>`;
}

function renderLearning(l) {
  if (!l) return;
  const el = $('learningBody');
  if (!l.ready) {
    el.innerHTML = `<p class="muted">Strâng rezultate forward: ${l.total || 0} rezolvate, ${l.pending || 0} în curs. Validarea cere ${l.minSample || 30} rezultate exacte per cohortă.</p>${cohortProgressHtml(l)}`;
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
    <p class="muted" style="margin-top:10px">Din ${l.total} rezultate forward rezolvate. Aplicația folosește asta ca să confirme sau să blocheze semnale noi automat.</p>
    ${cohortProgressHtml(l)}`;
}

// ---------- live journal ----------
function wr(o) {
  return o && o.n ? `${o.winRate}% <span class="muted">(${o.wins}/${o.n})</span>` : '<span class="muted">—</span>';
}
function renderJournal(d) {
  if (!d || !d.stats) return;
  const s = d.stats;
  const box = (val, lbl) => `<div class="bt-box"><div class="big" style="font-size:20px">${val}</div><div class="lbl">${lbl}</div></div>`;
  let html = box(wr(s.overall), 'general (toate)') +
    box(`${s.overall.pnl >= 0 ? '+' : ''}${Number(s.overall.pnl || 0).toFixed(2)} USDT`, 'paper P&L') +
    box(wr(s.validated), 'TRADE validate') +
    box(wr(s.technicalPaper), 'PAPER tehnice') +
    box(wr(s.sniper), '🎯 doar Sniper') +
    `<div class="bt-box"><div class="big" style="font-size:20px">${s.pending}</div><div class="lbl">în așteptare</div></div>` +
    `<div class="bt-box"><div class="big" style="font-size:20px">${s.void || 0}</div><div class="lbl">VOID (fără settlement)</div></div>`;
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
    const pnl = e.status === 'resolved' && Number.isFinite(e.pnl) && e.stake > 0
      ? ` · <b class="${e.pnl >= 0 ? 'ok' : 'bad'}">${e.pnl >= 0 ? '+' : ''}${Number(e.pnl).toFixed(2)} USDT</b>`
      : '';
    const st = e.status === 'pending'
      ? '<span class="muted">⏳ în așteptare</span>'
      : e.status === 'void'
        ? '<span class="muted">VOID · settlement indisponibil</span>'
        : (e.win ? `<span class="adir up">✓ WIN${pnl}</span>` : `<span class="adir down">✗ LOSS${pnl}</span>`);
    const dir = e.directie === 'UP' ? '▲' : '▼';
    const exit = e.exitPrice != null ? fmt(e.exitPrice) : '—';
    const kind = e.signalClass === 'validated-trade'
      ? '<span class="tag validated">VALIDAT</span>'
      : '<span class="tag paper">PAPER</span>';
    return `<div class="jrow">
      <span>${e.sniper ? '🎯 ' : ''}<b>${e.symbol}</b> ${dir} ${kind}</span>
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
  ACTIVE_SYMBOLS = c.symbols || [];
  $('symbols').value = (c.symbols || []).join('\n');
  $('scanInterval').value = c.scanIntervalSec;
  $('alertMinConfidence').value = c.alertMinConfidence;
  CONTINUOUS_MODE = c.continuousMode !== false;
  SNIPER_MODE = c.sniperMode === true;
  if (Array.isArray(c.activeHoursUTC) && c.activeHoursUTC.length) ACTIVE_HOURS = c.activeHoursUTC;
  updateSessionBadge();
  $('continuousMode').checked = CONTINUOUS_MODE;
  $('sniperMode').checked = SNIPER_MODE;
  $('sniperRequireVolume').checked = !!c.sniperRequireVolume;
  $('adaptiveInterval').checked = c.adaptiveInterval !== false;
  if (c.payout10) $('payout10').value = c.payout10;
  if (c.payout30) $('payout30').value = c.payout30;
  if (c.paperStake) $('paperStake').value = c.paperStake;
  $('useOrderFlow').checked = c.useOrderFlow !== false;
  $('requireOfAgree').checked = !!c.requireOfAgree;
  $('useLearning').checked = c.useLearning !== false;
  $('paperSignalsDuringCalibration').checked = c.paperSignalsDuringCalibration !== false;
  if (c.paperSignalCooldownMin) $('paperSignalCooldownMin').value = c.paperSignalCooldownMin;
  if (c.minCalibrationSamples) $('minCalibrationSamples').value = c.minCalibrationSamples;
  if (c.minCalibratedWinRate) $('minCalibratedWinRate').value = c.minCalibratedWinRate;
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
    continuousMode: $('continuousMode').checked,
    sniperMode: $('sniperMode').checked,
    sniperRequireVolume: $('sniperRequireVolume').checked,
    adaptiveInterval: $('adaptiveInterval').checked,
    payout10: Number($('payout10').value),
    payout30: Number($('payout30').value),
    paperStake: Number($('paperStake').value),
    useOrderFlow: $('useOrderFlow').checked,
    requireOfAgree: $('requireOfAgree').checked,
    useLearning: $('useLearning').checked,
    paperSignalsDuringCalibration: $('paperSignalsDuringCalibration').checked,
    paperSignalCooldownMin: Number($('paperSignalCooldownMin').value),
    minCalibrationSamples: Number($('minCalibrationSamples').value),
    minCalibratedWinRate: Number($('minCalibratedWinRate').value),
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
async function runBacktest() {
  const symbol = $('btSymbol').value;
  const days = $('btDays').value;
  $('btStatus').textContent = 'rulez pe istoric... (câteva secunde)';
  $('btResult').innerHTML = '';
  try {
    const r = await fetch(`/api/backtest?symbol=${symbol}&days=${days}`);
    const d = await r.json();
    if (d.error) { $('btStatus').textContent = 'eroare: ' + d.error; return; }
    $('btStatus').textContent = `${d.evaluated} semnale evaluate pe ${d.totalCandles} lumânări (${d.days} zile, sursă: ${d.source})`;
    const w = d.winRate;
    const box = (big, lbl) => `<div class="bt-box"><div class="big">${big ?? '—'}${big != null ? '%' : ''}</div><div class="lbl">${lbl}</div></div>`;
    $('btResult').innerHTML =
      box(w.overall, 'win-rate general') +
      box(w.Ridicat, `încredere Ridicat (${d.byConfidence.Ridicat.n})`) +
      box(w.Mediu, `încredere Mediu (${d.byConfidence.Mediu.n})`) +
      box(w.Scăzut, `încredere Scăzut (${d.byConfidence.Scăzut.n})`) +
      box(w.UP, `semnale UP (${d.byDirection.UP.n})`) +
      box(w.DOWN, `semnale DOWN (${d.byDirection.DOWN.n})`);
  } catch (e) {
    $('btStatus').textContent = 'eroare: ' + e.message;
  }
}

// ---------- wire up ----------
$('toggleSettings').addEventListener('click', () => $('settingsBody').classList.toggle('open'));
$('saveSettings').addEventListener('click', saveSettings);
$('testAi').addEventListener('click', testAi);
$('runBacktest').addEventListener('click', runBacktest);
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

loadState();
connect();
updateSessionBadge();
setInterval(updateSessionBadge, 60000);
