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
