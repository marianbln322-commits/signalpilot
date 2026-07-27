'use strict';

// ============================================================================
// Closed-bar walk-forward evaluation of the deterministic engine.
// It mirrors the 5m/15m/60m view and non-overlapping event windows. Historical
// candles are Binance proxy data, so order-flow/derivatives remain forward-only.
// ============================================================================

const binance = require('./binance');
const engine = require('./engine');

const WINDOW = 199;         // exact closed-candle window used live
const HORIZON_10 = 2;       // 2 x 5m = 10 min
const HORIZON_30 = 6;       // 6 x 5m = 30 min

// Map a raw signal label to a setup category (for per-setup win-rate).
function categorize(label) {
  const l = label.toLowerCase();
  if (l.includes('sweep')) return 'Liquidity Sweep';
  if (l.includes('squeeze')) return 'Bollinger Squeeze breakout';
  if (l.includes('structure shift')) return 'Market Structure Shift';
  if (l.includes('ifvg')) return 'Inversion FVG retest';
  if (l.includes('fvg')) return 'FVG retest';
  if (l.includes('divergen')) return 'RSI divergence';
  if (l.includes('crossover')) return 'MACD crossover';
  if (l.includes('absorb') || l.includes('distribu')) return 'Volume absorption';
  if (l.includes('reversie') || l.includes('band')) return 'Bollinger bounce';
  return 'other';
}

const TRIGGER_RE = /sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band/i;

async function run(symbol, opts = {}) {
  const days = Math.min(60, Math.max(3, opts.days || 15));
  const endDaysAgo = Math.max(0, opts.endDaysAgo || 0);
  const endTimeMs = endDaysAgo > 0 ? Date.now() - endDaysAgo * 86400 * 1000 : null;
  const tf5Raw = await binance.fetchHistory(symbol, '5m', days, 1000, endTimeMs);
  const tf15Raw = await binance.fetchHistory(symbol, '15m', days, 1000, endTimeMs);
  const tf60Raw = await binance.fetchHistory(symbol, '1h', days + 10, 1000, endTimeMs);
  const replayEnd = endTimeMs || Date.now();
  const tf5 = tf5Raw.filter((c) => c.closeTime <= replayEnd);
  const tf15 = tf15Raw.filter((c) => c.closeTime <= replayEnd);
  const tf60 = tf60Raw.filter((c) => c.closeTime <= replayEnd);
  const requireSniperVolume = opts.sniperRequireVolume === true;

  const stats = {
    symbol,
    source: 'binance.vision (proxy; nu reproduce microstructura MEXC)',
    policy: {
      closedBars: true,
      includes60m: true,
      windowCandles: WINDOW,
      sniperRequireVolume: requireSniperVolume,
      activeHoursUTC: Array.isArray(opts.activeHoursUTC)
        ? opts.activeHoursUTC
        : [6, 7, 8, 9, 13, 14, 15, 16, 17],
    },
    days,
    totalCandles: tf5.length,
    evaluated: 0,
    byConfidence: {
      Ridicat: { n: 0, wins: 0 },
      Mediu: { n: 0, wins: 0 },
      Scăzut: { n: 0, wins: 0 },
    },
    byDirection: { UP: { n: 0, wins: 0 }, DOWN: { n: 0, wins: 0 } },
    bySetup: {},        // primary trigger category -> {n, wins}
    strong: { n: 0, wins: 0 },   // only |net| >= 5 (rare, high-conviction)
    veryStrong: { n: 0, wins: 0 }, // only |net| >= 7
    byHour: {},         // UTC hour -> {n, wins}  (all signals)
    sweepAll: { n: 0, wins: 0 },
    sweepActiveHours: { n: 0, wins: 0 }, // sweep during EU/US session windows
    sniper: { n: 0, wins: 0 },  // sweep + active hours + volume-confirmed
    trades: [],
  };

  const configuredHours = Array.isArray(opts.activeHoursUTC)
    ? opts.activeHoursUTC
    : [6, 7, 8, 9, 13, 14, 15, 16, 17];
  const ACTIVE_HOURS = new Set(configuredHours);
  const allHoursActive = configuredHours.length === 0;

  const maxHorizon = HORIZON_30;
  let blockedUntil = -1;

  for (let i = WINDOW - 1; i < tf5.length - maxHorizon; i++) {
    const window5 = tf5.slice(i - WINDOW + 1, i + 1);
    const currentCloseTime = tf5[i].closeTime;
    const window15 = tf15.filter((c) => c.closeTime <= currentCloseTime).slice(-WINDOW);
    const window60 = tf60.filter((c) => c.closeTime <= currentCloseTime).slice(-WINDOW);
    if (window15.length < 60 || window60.length < 60) continue;

    let verdict;
    try {
      verdict = engine.decide({ '5m': window5, '15m': window15, '60m': window60 });
    } catch {
      continue;
    }
    if (verdict.directie === 'NEUTRU') continue;

    const horizon = verdict.interval === '10 minute' ? HORIZON_10 : HORIZON_30;
    // Event windows must not overlap; otherwise n grossly overstates the number
    // of independent outcomes, especially for 30-minute signals.
    if (i < blockedUntil) continue;
    blockedUntil = i + horizon;

    const outIdx = i + horizon;
    if (outIdx >= tf5.length) continue;

    const entry = tf5[i].close;
    const exit = tf5[outIdx].close;
    const win = verdict.directie === 'UP' ? exit > entry : exit < entry;

    stats.evaluated++;
    const conf = verdict.incredere;
    if (stats.byConfidence[conf]) {
      stats.byConfidence[conf].n++;
      if (win) stats.byConfidence[conf].wins++;
    }
    stats.byDirection[verdict.directie].n++;
    if (win) stats.byDirection[verdict.directie].wins++;

    // Per-setup: use the highest-weight TRIGGER signal on the winning side.
    const primaryTrigger = (verdict.signals || []).find((s) => TRIGGER_RE.test(s.label));
    let isSweep = false;
    let sweepVolConfirmed = false;
    if (primaryTrigger) {
      const cat = categorize(primaryTrigger.label);
      if (!stats.bySetup[cat]) stats.bySetup[cat] = { n: 0, wins: 0 };
      stats.bySetup[cat].n++;
      if (win) stats.bySetup[cat].wins++;
      isSweep = cat === 'Liquidity Sweep';
      sweepVolConfirmed = isSweep && /volum ridicat/i.test(primaryTrigger.label);
    }

    // Hour-of-day (UTC) breakdown.
    const hour = new Date(tf5[i].closeTime).getUTCHours();
    if (!stats.byHour[hour]) stats.byHour[hour] = { n: 0, wins: 0 };
    stats.byHour[hour].n++;
    if (win) stats.byHour[hour].wins++;

    const inActive = allHoursActive || ACTIVE_HOURS.has(hour);
    if (isSweep) {
      stats.sweepAll.n++; if (win) stats.sweepAll.wins++;
      if (inActive) { stats.sweepActiveHours.n++; if (win) stats.sweepActiveHours.wins++; }
      // Match the live configuration: volume is optional by default.
      if (inActive && (!requireSniperVolume || sweepVolConfirmed)) {
        stats.sniper.n++;
        if (win) stats.sniper.wins++;
      }
    }

    // Strong-conviction filters (selectivity test).
    const absNet = Math.abs(verdict.scores.net);
    if (absNet >= 5) { stats.strong.n++; if (win) stats.strong.wins++; }
    if (absNet >= 7) { stats.veryStrong.n++; if (win) stats.veryStrong.wins++; }

    if (stats.trades.length < 200) {
      stats.trades.push({
        time: new Date(tf5[i].openTime).toISOString(),
        directie: verdict.directie,
        interval: verdict.interval,
        incredere: conf,
        entry: +entry.toFixed(2),
        exit: +exit.toFixed(2),
        win,
      });
    }
  }

  // Win-rate percentages.
  const pct = (o) => (o.n ? +((o.wins / o.n) * 100).toFixed(1) : null);
  stats.winRate = {
    overall: pct({
      n: stats.evaluated,
      wins: Object.values(stats.byConfidence).reduce((s, o) => s + o.wins, 0),
    }),
    Ridicat: pct(stats.byConfidence.Ridicat),
    Mediu: pct(stats.byConfidence.Mediu),
    Scăzut: pct(stats.byConfidence.Scăzut),
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
      .map(([h, v]) => [h, { winRate: pct(v), n: v.n }])
      .sort((a, b) => Number(a[0]) - Number(b[0]))
  );
  stats.setupWinRate = Object.fromEntries(
    Object.entries(stats.bySetup)
      .map(([k, v]) => [k, { winRate: pct(v), n: v.n }])
      .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0))
  );

  return stats;
}

module.exports = { run };
