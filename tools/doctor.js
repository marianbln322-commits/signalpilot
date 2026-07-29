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
