'use strict';

// SignalPilot frontend: subscribes to SSE, renders live cards + alerts,
// handles settings save, AI key test, and backtest.

const $ = (id) => document.getElementById(id);
const cardsEl = $('cards');
const alertsEl = $('alerts');
let cards = {}; // symbol -> element
let soundOn = true;
let SNIPER_MODE = true; // set from server config on load

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
  }
  return parts.join('');
}

function renderCard(v) {
  const dir = v.directie.toLowerCase();
  const eligible = v.sniper && v.sniper.eligible;
  const sigs = (v.signals || []).slice(0, 5).map((s) => `<li>${s.label} <span class="muted">[${s.tf}]</span></li>`).join('');
  const ai = v.ai
    ? `<div class="ai-note">🤖 <b>AI (${v.ai.acord || '—'})</b>: ${v.ai.risc ? '⚠️ ' + v.ai.risc : ''} ${v.ai.comentariu || ''}</div>`
    : (v.aiError ? `<div class="ai-note">🤖 AI indisponibil: ${v.aiError}</div>` : '');

  // The BIG banner: the only thing you act on. Sniper Mode = trade only on 🎯.
  const adapt = v.intervalAdapted ? ' · 🔄 adaptat 10→30' : '';
  let banner;
  if (SNIPER_MODE) {
    banner = eligible
      ? `<div class="cta go ${dir}">🎯 INTRĂ ${v.directie} ${v.directie === 'UP' ? '▲' : '▼'}<div class="cta-sub">pe MEXC event futures · fereastră ${v.interval}${adapt}</div></div>`
      : `<div class="cta wait">⏳ AȘTEAPTĂ<div class="cta-sub">nu e încă setup A+: ${v.sniper ? v.sniper.reason : '—'}</div></div>`;
  } else {
    banner = `<div class="cta go ${dir}">${v.directie} ${v.directie === 'UP' ? '▲' : v.directie === 'DOWN' ? '▼' : ''}<div class="cta-sub">fereastră ${v.interval}${adapt} · încredere ${v.incredere}</div></div>`;
  }

  return `
    <div class="card-top">
      <span class="card-sym">${v.symbol}</span>
      <span class="card-price">${fmt(v.price)} USDT</span>
    </div>
    ${banner}
    <details class="analysis">
      <summary>Analiza motorului (context, nu semnal de intrare)</summary>
      <div class="row5">
        <b>Direcție motor</b><span class="dir-inline ${dir}">${v.directie} · ${v.interval}</span>
        <b>Încredere</b><span><span class="pill ${v.incredere}">${v.incredere}</span> <span class="muted">(net ${v.scores.net})</span></span>
        <b>Justificare</b><span>${v.justificare}</span>
        <b>Invalidare</b><span>${v.invalidare}</span>
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
  es.addEventListener('journal', (e) => renderJournal(JSON.parse(e.data)));
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
  $('sniperMode').checked = c.sniperMode !== false;
  $('sniperRequireVolume').checked = c.sniperRequireVolume !== false;
  $('adaptiveInterval').checked = c.adaptiveInterval !== false;
  if (c.adaptive10minThreshold) $('adaptive10minThreshold').value = c.adaptive10minThreshold;
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
    adaptive10minThreshold: Number($('adaptive10minThreshold').value),
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
