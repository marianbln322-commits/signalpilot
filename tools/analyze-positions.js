#!/usr/bin/env node
'use strict';

// ============================================================================
// analyze-positions.js — verdictul pe istoricul REAL de poziții închise MEXC.
//
// DE CE EXISTĂ
// Un backtest pe date proxy (spot Binance, preț last în loc de index) estimează
// un edge. Pozițiile tale închise nu estimează nimic: sunt rezultate decontate
// de MEXC, pe regulile lui, la payout-urile pe care le-ai primit efectiv. E cea
// mai bună dovadă disponibilă și, în plus, rezolvă problema de cold-start —
// aplicația poate porni calibrată în loc să aștepte luni de forward-testing.
//
// CE CITEȘTE
// Un CSV cu pozițiile închise. Numele coloanelor sunt tolerante (RO sau EN):
//
//   time,symbol,interval,stake,entry,settle,pnl
//   2026-08-08 16:19,ETHUSDT,10,5,1919.88,1921.40,3.5
//
//   time      (opțional) data/ora intrării — folosită pentru analiza pe oră
//   symbol    ETHUSDT / BTCUSDT
//   interval  10 sau 30 (minute); acceptă și "10m", "10 minute"
//   stake     miza în USDT
//   entry     prețul la intrare
//   settle    prețul la expirare
//   pnl       profitul în USDT (negativ la pierdere) SAU
//   pnlRate   procentul (ex. 70 sau -100) SAU
//   payout+direction  dacă le ai explicit
//
// Direcția se deduce: dacă e câștig, direcția coincide cu sensul mișcării;
// dacă e pierdere, e opusă. Deci nu trebuie s-o notezi manual.
//
// UTILIZARE
//   node tools/analyze-positions.js pozitii.csv
//   node tools/analyze-positions.js pozitii.csv --seed-calibration
// ============================================================================

const fs = require('fs');
const path = require('path');
const cal = require('../lib/calibration');

// ---- Parsare CSV tolerantă --------------------------------------------------

const ALIASES = {
  time: ['time', 'date', 'datetime', 'data', 'ora', 'timp', 'opentime', 'entrytime'],
  symbol: ['symbol', 'simbol', 'pair', 'moneda', 'coin', 'contract'],
  interval: ['interval', 'durata', 'duration', 'window', 'timeunit', 'fereastra', 'period'],
  stake: ['stake', 'amount', 'suma', 'miza', 'investit', 'invested', 'size'],
  entry: ['entry', 'entryprice', 'intrare', 'pretintrare', 'open', 'openprice'],
  settle: ['settle', 'settleprice', 'settlementprice', 'expirare', 'exit', 'exitprice', 'close', 'closeprice', 'pretexpirare'],
  pnl: ['pnl', 'profit', 'pierdere', 'rezultat', 'pnlusdt', 'realizedpnl'],
  pnlRate: ['pnlrate', 'pnlpercent', 'rata', 'ratapnl', 'roi', 'randament'],
  payout: ['payout', 'payoutpct', 'payoutrate', 'rataplata'],
  direction: ['direction', 'directie', 'side', 'updown', 'sens'],
};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function mapHeader(cols) {
  const map = {};
  cols.forEach((raw, i) => {
    const n = norm(raw);
    for (const [canon, alts] of Object.entries(ALIASES)) {
      if (alts.includes(n)) { map[canon] = i; return; }
    }
  });
  return map;
}

function splitLine(line) {
  // Acceptă virgulă, punct-virgulă sau tab; respectă ghilimelele.
  const delim = line.includes('\t') ? '\t' : (line.split(';').length > line.split(',').length ? ';' : ',');
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === delim && !q) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Numerele pot veni ca "1,919.88" sau "1919,88" sau "+3.5 USDT".
function num(v) {
  if (v == null) return null;
  let s = String(v).replace(/[^\d.,+-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseInterval(v) {
  const n = num(v);
  if (n === 10 || n === 30) return n === 10 ? '10 minute' : '30 minute';
  const s = String(v || '').toLowerCase();
  if (s.includes('30')) return '30 minute';
  if (s.includes('10')) return '10 minute';
  return null;
}

function load(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) throw new Error('fișier gol');
  const header = splitLine(lines[0]);
  const map = mapHeader(header);

  const missing = ['stake', 'entry', 'settle'].filter((k) => map[k] == null);
  if (missing.length) {
    throw new Error(
      `lipsesc coloanele obligatorii: ${missing.join(', ')}\n` +
      `  header găsit: ${header.join(' | ')}\n` +
      `  aliasuri acceptate: ${missing.map((m) => `${m} -> ${ALIASES[m].join('/')}`).join('; ')}`
    );
  }
  if (map.pnl == null && map.pnlRate == null && map.direction == null) {
    throw new Error(
      'am nevoie de una dintre: pnl (USDT), pnlRate (%), sau direction (Up/Down),\n' +
      '  ca să pot stabili dacă poziția a fost câștigătoare.'
    );
  }

  const rows = [];
  const problems = [];
  lines.slice(1).forEach((line, i) => {
    const c = splitLine(line);
    const get = (k) => (map[k] != null ? c[map[k]] : null);
    const stake = num(get('stake'));
    const entry = num(get('entry'));
    const settle = num(get('settle'));
    if (stake == null || entry == null || settle == null) {
      problems.push(`linia ${i + 2}: valori numerice lipsă`);
      return;
    }

    const pnl = num(get('pnl'));
    const pnlRate = num(get('pnlRate'));
    const dirRaw = get('direction');

    // Câștig/pierdere
    let win = null;
    if (pnl != null) win = pnl > 0;
    else if (pnlRate != null) win = pnlRate > 0;
    else if (dirRaw) {
      const up = /up|long|sus|buy|cre/i.test(dirRaw);
      win = up ? settle > entry : settle < entry;
    }
    if (win == null) { problems.push(`linia ${i + 2}: nu pot stabili rezultatul`); return; }

    // Direcția: la câștig coincide cu mișcarea, la pierdere e opusă.
    let directie;
    if (dirRaw) directie = /up|long|sus|buy|cre/i.test(dirRaw) ? 'UP' : 'DOWN';
    else if (settle === entry) directie = null;
    else directie = (settle > entry) === win ? 'UP' : 'DOWN';

    // Payout efectiv: cât ai primit peste miză, raportat la miză.
    let payout = num(get('payout'));
    if (payout == null && win) {
      if (pnlRate != null && pnlRate > 0) payout = pnlRate;
      else if (pnl != null && stake > 0) payout = (pnl / stake) * 100;
    }

    // O egalitate perfectă e RAMBURSARE pe MEXC: miza se întoarce integral, deci
    // rezultatul e nul, nu o pierdere. Confirmat pe istoric real: payout-ul
    // returnat era exact egal cu miza. Numărarea ei ca pierdere ar subestima
    // sistematic win-rate-ul.
    const tie = settle === entry || (pnl != null && pnl === 0);

    rows.push({
      time: get('time') || null,
      symbol: (get('symbol') || 'necunoscut').toUpperCase().replace(/[^A-Z0-9]/g, ''),
      interval: parseInterval(get('interval')) || 'necunoscut',
      stake, entry, settle, directie,
      win: tie ? null : win,
      tie,
      payout: payout != null ? +payout.toFixed(1) : null,
      pnl: pnl != null ? pnl : (win && payout != null ? stake * (payout / 100) : (win ? null : -stake)),
      movePct: entry ? ((settle - entry) / entry) * 100 : null,
    });
  });

  return { rows, problems, header };
}

// ---- Analiză ---------------------------------------------------------------

function agg(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  if (!n) return { n: 0, wins: 0, winRate: null };
  const w = cal.wilson(wins, n);
  const w90 = cal.wilson(wins, n, 1.2816);
  return {
    n, wins,
    winRate: +((wins / n) * 100).toFixed(1),
    ciLow: w.low, ciHigh: w.high,
    ciLow90: w90.low,
  };
}

// Payout mediu ponderat cu miza — reperul corect, fiindcă mizele pot diferi.
function blendedPayout(rows) {
  const known = rows.filter((r) => r.payout != null && r.payout > 0);
  if (!known.length) return null;
  const totalStake = known.reduce((s, r) => s + r.stake, 0);
  if (!totalStake) return null;
  return +(known.reduce((s, r) => s + r.payout * r.stake, 0) / totalStake).toFixed(1);
}

// Payout-ul se poate deduce din P&L numai pentru pozițiile CÂȘTIGĂTOARE: la o
// pierdere pierzi miza, iar suma pierdută nu conține nicio informație despre
// payout-ul care ți se oferea. Fără o coloană explicită de payout, orice grupare
// pe niveluri de payout ar conține doar câștiguri și ar raporta 100% pe fiecare
// nivel — un tabel care pare informativ și e complet gol de sens. Detectăm asta
// și refuzăm să-l afișăm.
function payoutCoverage(rows) {
  const wins = rows.filter((r) => r.win);
  const losses = rows.filter((r) => !r.win);
  const winsKnown = wins.filter((r) => r.payout != null).length;
  const lossesKnown = losses.filter((r) => r.payout != null).length;
  return {
    wins: wins.length,
    losses: losses.length,
    winsKnown,
    lossesKnown,
    // Gruparea pe niveluri are sens doar dacă știm payout-ul și la pierderi.
    canGroupByTier: losses.length === 0 || lossesKnown > 0,
    derivedFromPnlOnly: lossesKnown === 0 && winsKnown > 0,
  };
}

function tierOf(payout) {
  if (payout == null) return 'necunoscut';
  if (payout >= 82.5) return '85%';
  if (payout >= 75) return '80%';
  if (payout >= 55) return '70%';
  if (payout >= 32.5) return '40%';
  if (payout >= 17.5) return '25%';
  return '10%';
}

function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function table(title, m, extra) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  const keys = [...m.keys()].sort();
  if (!keys.length) { console.log('  (fără date)'); return; }
  console.log('  ' + 'grup'.padEnd(14) + 'n'.padStart(5) + 'win-rate'.padStart(10) +
    'CI 95%'.padStart(18) + (extra ? extra.header : ''));
  for (const k of keys) {
    const rows = m.get(k);
    const a = agg(rows);
    console.log(
      '  ' + String(k).padEnd(14) + String(a.n).padStart(5) +
      `${a.winRate}%`.padStart(10) +
      `${a.ciLow}–${a.ciHigh}%`.padStart(18) +
      (extra ? extra.cell(rows, a) : '')
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Utilizare: node tools/analyze-positions.js pozitii.csv [--seed-calibration]');
    console.error('\nCSV minim:  symbol,interval,stake,entry,settle,pnl');
    process.exit(1);
  }
  const { rows: allRows, problems, header } = load(path.resolve(file));
  // Egalitățile sunt rambursate, deci nu intră în niciun win-rate. Rămân însă în
  // rulaj și în P&L (cu 0), ca să nu dispară din contabilitate.
  const rows = allRows.filter((r) => !r.tie);

  console.log('='.repeat(74));
  console.log('  ISTORIC REAL DE POZIȚII MEXC — rezultate decontate, nu backtest');
  console.log('='.repeat(74));
  console.log(`  fișier   : ${file}`);
  console.log(`  coloane  : ${header.join(' | ')}`);
  console.log(`  poziții  : ${allRows.length}`);
  if (problems.length) {
    console.log(`  ignorate : ${problems.length}`);
    problems.slice(0, 5).forEach((p) => console.log(`    - ${p}`));
  }
  if (!rows.length) process.exit(1);

  const ties = allRows.filter((r) => r.tie);
  if (ties.length) {
    console.log(`  egalități: ${ties.length} — rambursate (miza înapoi), deci excluse din win-rate`);
    console.log(`  evaluate : ${rows.length}`);
  }

  const overall = agg(rows);
  const bp = blendedPayout(rows);
  const totalStake = allRows.reduce((s, r) => s + r.stake, 0);
  const knownPnl = allRows.filter((r) => r.pnl != null);
  const netPnl = knownPnl.reduce((s, r) => s + r.pnl, 0);

  console.log('\n' + '='.repeat(74));
  console.log('  VERDICT');
  console.log('='.repeat(74));
  console.log(`  win-rate realizat      : ${overall.winRate}%  (${overall.wins}/${overall.n})`);
  console.log(`  interval încredere 95% : ${overall.ciLow}% – ${overall.ciHigh}%`);
  console.log(`  limita inferioară 90%  : ${overall.ciLow90}%`);

  const cov = payoutCoverage(rows);

  if (bp != null) {
    const be = cal.breakEvenWinRate(bp);
    const evTheo = cal.expectedValue(overall.winRate, bp);
    console.log(`\n  payout mediu (pond.)   : ${bp}%` +
      (cov.derivedFromPnlOnly ? '   [dedus DOAR din pozițiile câștigătoare]' : ''));
    console.log(`  break-even necesar     : ${be}%`);
    console.log(`  EV la win-rate-ul tău  : ${evTheo > 0 ? '+' : ''}${evTheo}% pe tranzacție`);

    const verdict = overall.ciLow >= be ? 'PESTE break-even, statistic semnificativ'
      : overall.winRate >= be ? 'peste break-even, dar NU semnificativ (intervalul include break-even-ul)'
        : overall.ciHigh < be ? 'SUB break-even, statistic semnificativ'
          : 'sub break-even, dar intervalul îl include — nedecis';
    console.log(`\n  >>> ${verdict}`);

    const cf = cal.vsCoinFlip(overall.wins, overall.n);
    console.log(`  vs. monedă (50%)       : z=${cf.z}, p=${cf.pValue}` +
      (cf.significant ? '  (diferit de hazard)' : '  (nedistinct de hazard)'));

    // Câte poziții ar mai trebui la același win-rate pentru semnificație?
    if (overall.ciLow < be && overall.winRate > be) {
      let need = overall.n;
      const rate = overall.wins / overall.n;
      while (need < 5000) {
        need += 10;
        if (cal.wilson(Math.round(rate * need), need).low >= be) break;
      }
      console.log(`  pentru certitudine     : ~${need} poziții la același ritm (ai ${overall.n})`);
    }
  } else {
    console.log('\n  payout necunoscut — adaugă coloana pnl sau payout ca să pot calcula break-even-ul.');
  }

  console.log(`\n  rulaj total            : ${totalStake.toFixed(2)} USDT`);
  if (knownPnl.length === rows.length) {
    console.log(`  P&L net realizat       : ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} USDT ` +
      `(${((netPnl / totalStake) * 100).toFixed(2)}% din rulaj)`);
  }

  // ---- Stake-weighted: win-rate poate fi pozitiv iar P&L negativ -----------
  if (knownPnl.length === allRows.length && rows.some((r) => r.stake !== rows[0].stake)) {
    const wonStake = rows.filter((r) => r.win).reduce((s, r) => s + r.stake, 0);
    const lostStake = rows.filter((r) => !r.win).reduce((s, r) => s + r.stake, 0);
    const avgWin = wonStake / Math.max(1, rows.filter((r) => r.win).length);
    const avgLoss = lostStake / Math.max(1, rows.filter((r) => !r.win).length);
    console.log('\nMiza pe rezultat (mizele tale nu sunt egale)');
    console.log('--------------------------------------------');
    console.log(`  miză medie pe câștiguri : ${avgWin.toFixed(2)} USDT`);
    console.log(`  miză medie pe pierderi  : ${avgLoss.toFixed(2)} USDT`);
    if (avgLoss > avgWin * 1.15) {
      console.log(`  >>> Pariezi cu ${((avgLoss / avgWin - 1) * 100).toFixed(0)}% mai mult pe pozițiile care pierd.`);
      console.log('      Asta poate face contul negativ chiar cu un win-rate peste break-even.');
      console.log('      Miză fixă ar elimina complet efectul.');
    }
  }

  // ---- Defalcări ----
  if (cov.canGroupByTier) {
    table('Pe nivel de payout', group(rows, (r) => tierOf(r.payout)), {
      header: 'break-even'.padStart(12) + 'EV'.padStart(10),
      cell: (rs, a) => {
        const p = blendedPayout(rs);
        if (p == null) return '—'.padStart(12) + '—'.padStart(10);
        const be = cal.breakEvenWinRate(p);
        const ev = cal.expectedValue(a.winRate, p);
        return `${be}%`.padStart(12) + `${ev > 0 ? '+' : ''}${ev}%`.padStart(10);
      },
    });
  } else {
    console.log('\nPe nivel de payout');
    console.log('------------------');
    console.log(`  NU pot face această defalcare. Payout-ul e cunoscut la ${cov.winsKnown}/${cov.wins}`);
    console.log(`  câștiguri, dar la 0/${cov.losses} pierderi — pentru că o pierdere e mereu -100%`);
    console.log('  din miză, indiferent de payout-ul care ți se oferea.');
    console.log('  Gruparea ar conține doar câștiguri și ar arăta 100% pe fiecare nivel.');
    console.log('\n  >>> Adaugă o coloană `payout` în CSV (procentul afișat la intrare) și');
    console.log('      defalcarea devine posibilă. E întrebarea cea mai importantă:');
    console.log('      payout-ul mare apare în momentele mai greu de prezis, sau nu?');
  }

  table('Pe fereastră', group(rows, (r) => r.interval));
  table('Pe simbol', group(rows, (r) => r.symbol));
  table('Pe direcție', group(rows, (r) => r.directie || 'egalitate'));

  if (rows.some((r) => r.time)) {
    const hourly = group(rows, (r) => {
      const d = new Date(r.time);
      return Number.isNaN(d.getTime()) ? null : `${String(d.getUTCHours()).padStart(2, '0')}h UTC`;
    });
    if (hourly.size) table('Pe oră (doar grupuri cu n≥5)', new Map([...hourly].filter(([, v]) => v.length >= 5)));
  }

  // Mărimea mișcării: contractele binare se decid adesea la câțiva bps.
  const moves = rows.filter((r) => r.movePct != null).map((r) => Math.abs(r.movePct)).sort((a, b) => a - b);
  if (moves.length) {
    const q = (p) => moves[Math.floor(p * (moves.length - 1))].toFixed(3);
    console.log('\nMărimea mișcării până la decontare (|%|)');
    console.log('---------------------------------------');
    console.log(`  median ${q(0.5)}%   p25 ${q(0.25)}%   p75 ${q(0.75)}%   p95 ${q(0.95)}%`);
    const tiny = moves.filter((m) => m < 0.02).length;
    console.log(`  sub 0.02% (aproape egalitate): ${tiny} din ${moves.length}` +
      (tiny > moves.length * 0.1
        ? '  <-- multe decizii se iau la limită; prețul de referință exact contează enorm'
        : ''));
  }

  if (args.includes('--seed-calibration')) {
    const samples = rows
      .filter((r) => r.interval !== 'necunoscut')
      .map((r) => ({ setup: 'istoric-mexc', interval: r.interval, score: null, win: r.win }));
    const model = cal.fit(samples, { minSample: 30 });
    const out = path.join(__dirname, '..', 'calibration.json');
    fs.writeFileSync(out, JSON.stringify({ ...model, seededFrom: 'pozitii MEXC reale' }, null, 2));
    console.log(`\n>>> calibration.json scris din ${samples.length} poziții reale.`);
    console.log('    Atenție: bucket-ul e "istoric-mexc", fără tip de setup, fiindcă istoricul');
    console.log('    MEXC nu-l conține. E un reper global, nu o calibrare pe setup.');
  }

  console.log('\n' + '='.repeat(74));
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error(`\nEroare: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { load, agg, blendedPayout, tierOf };
