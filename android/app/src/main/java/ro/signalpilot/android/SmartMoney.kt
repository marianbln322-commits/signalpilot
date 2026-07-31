package ro.signalpilot.android

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

object SmartMoney {
    data class Swing(val index: Int, val price: Double)
    data class SwingSet(val highs: List<Swing>, val lows: List<Swing>)
    data class Structure(val trend: String, val shift: String?, val highs: List<Swing>, val lows: List<Swing>)
    data class Gap(val type: String, val top: Double, val bottom: Double, val index: Int, val inverted: Boolean, val effectiveType: String)
    data class GapResult(val gaps: List<Gap>, val retest: Gap?)
    data class Sweep(val type: String, val sweptLevel: Double, val wickExtreme: Double, val volumeSpike: Boolean, val strength: Double)

    fun swings(candles: List<Candle>, span: Int = 2): SwingSet {
        val highs = mutableListOf<Swing>()
        val lows = mutableListOf<Swing>()
        for (i in span until candles.size - span) {
            var isHigh = true
            var isLow = true
            for (j in i - span..i + span) {
                if (j == i) continue
                if (candles[j].high >= candles[i].high) isHigh = false
                if (candles[j].low <= candles[i].low) isLow = false
            }
            if (isHigh) highs += Swing(i, candles[i].high)
            if (isLow) lows += Swing(i, candles[i].low)
        }
        return SwingSet(highs, lows)
    }

    fun marketStructure(candles: List<Candle>, span: Int = 2): Structure {
        val points = swings(candles, span)
        if (points.highs.size < 2 || points.lows.size < 2) return Structure("range", null, points.highs, points.lows)
        val h1 = points.highs[points.highs.lastIndex - 1].price
        val h2 = points.highs.last().price
        val l1 = points.lows[points.lows.lastIndex - 1].price
        val l2 = points.lows.last().price
        val trend = when {
            h2 > h1 && l2 > l1 -> "up"
            h2 < h1 && l2 < l1 -> "down"
            else -> "range"
        }
        val close = candles.last().close
        val shift = when {
            close > points.highs.last().price && trend != "up" -> "bullish"
            close < points.lows.last().price && trend != "down" -> "bearish"
            else -> null
        }
        return Structure(trend, shift, points.highs, points.lows)
    }

    fun fairValueGaps(candles: List<Candle>, lookback: Int = 60): GapResult {
        val raw = mutableListOf<Gap>()
        for (i in max(2, candles.size - lookback) until candles.size) {
            val a = candles[i - 2]
            val c = candles[i]
            if (c.low > a.high) raw += Gap("bullish", c.low, a.high, i, false, "bullish")
            if (c.high < a.low) raw += Gap("bearish", a.low, c.high, i, false, "bearish")
        }
        val enriched = raw.map { gap ->
            var inverted = false
            for (i in gap.index + 1 until candles.size) {
                val close = candles[i].close
                if (gap.type == "bullish" && close < gap.bottom) inverted = true
                if (gap.type == "bearish" && close > gap.top) inverted = true
            }
            gap.copy(inverted = inverted, effectiveType = if (!inverted) gap.type else if (gap.type == "bullish") "bearish" else "bullish")
        }
        val last = candles.last()
        return GapResult(enriched, enriched.firstOrNull { last.low <= it.top && last.high >= it.bottom })
    }

    fun liquiditySweep(candles: List<Candle>, span: Int = 2, volumeAverage: Double? = null): Sweep? {
        if (candles.size < 6) return null
        val points = swings(candles.dropLast(1), span)
        val last = candles.last()
        val body = abs(last.close - last.open)
        val upperWick = last.high - max(last.close, last.open)
        val lowerWick = min(last.close, last.open) - last.low
        val range = (last.high - last.low).coerceAtLeast(1e-9)
        val spike = volumeAverage != null && last.volume > volumeAverage * 1.3
        val recentLow = points.lows.lastOrNull()?.price
        if (recentLow != null && last.low < recentLow && last.close > recentLow && lowerWick > body && lowerWick / range > .5) {
            return Sweep("bullish", recentLow, last.low, spike, lowerWick / range + if (spike) .5 else 0.0)
        }
        val recentHigh = points.highs.lastOrNull()?.price
        if (recentHigh != null && last.high > recentHigh && last.close < recentHigh && upperWick > body && upperWick / range > .5) {
            return Sweep("bearish", recentHigh, last.high, spike, upperWick / range + if (spike) .5 else 0.0)
        }
        return null
    }
}
