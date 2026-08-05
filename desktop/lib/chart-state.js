'use strict';

const expertEngine = require('./expert-engine');

function buildChartData(snapshot, result) {
  const analyses = { ...result.predictions['10m'].timeframeAnalyses, ...result.predictions['30m'].timeframeAnalyses };
  return Object.fromEntries(Object.entries(snapshot.candles).map(([timeframe, candles]) => {
    const closes = candles.map((candle) => candle.close);
    const ema9 = expertEngine.indicators.ema(closes, 9) || [];
    const ema20 = expertEngine.indicators.ema(closes, 20) || [];
    const ema50 = expertEngine.indicators.ema(closes, 50) || [];
    const visible = candles.map((candle, index) => ({
      openTime: candle.openTime, open: candle.open, high: candle.high, low: candle.low,
      close: candle.close, closeTime: candle.closeTime,
      ema9: ema9[index], ema20: ema20[index], ema50: ema50[index],
    }));
    return [timeframe, {
      candles: visible, displayedCount: visible.length, analysisCount: candles.length,
      overlay: analyses[timeframe] ? analyses[timeframe].overlay : null,
    }];
  }));
}

module.exports = { buildChartData };
