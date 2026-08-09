package ro.signalpilot.android

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sqrt

object Indicators {
    fun sma(values: List<Double>, period: Int): List<Double?>? {
        if (values.size < period) return null
        val out = MutableList<Double?>(values.size) { null }
        var sum = 0.0
        for (i in values.indices) {
            sum += values[i]
            if (i >= period) sum -= values[i - period]
            if (i >= period - 1) out[i] = sum / period
        }
        return out
    }

    fun ema(values: List<Double>, period: Int): List<Double?>? {
        if (values.size < period) return null
        val out = MutableList<Double?>(values.size) { null }
        val k = 2.0 / (period + 1)
        var seed = values.take(period).average()
        out[period - 1] = seed
        for (i in period until values.size) {
            seed = values[i] * k + seed * (1 - k)
            out[i] = seed
        }
        return out
    }

    fun rsi(closes: List<Double>, period: Int = 14): List<Double?>? {
        if (closes.size < period + 1) return null
        val out = MutableList<Double?>(closes.size) { null }
        var gain = 0.0
        var loss = 0.0
        for (i in 1..period) {
            val diff = closes[i] - closes[i - 1]
            if (diff >= 0) gain += diff else loss -= diff
        }
        var avgGain = gain / period
        var avgLoss = loss / period
        out[period] = if (avgLoss == 0.0) 100.0 else 100 - 100 / (1 + avgGain / avgLoss)
        for (i in period + 1 until closes.size) {
            val diff = closes[i] - closes[i - 1]
            val g = if (diff > 0) diff else 0.0
            val l = if (diff < 0) -diff else 0.0
            avgGain = (avgGain * (period - 1) + g) / period
            avgLoss = (avgLoss * (period - 1) + l) / period
            out[i] = if (avgLoss == 0.0) 100.0 else 100 - 100 / (1 + avgGain / avgLoss)
        }
        return out
    }

    data class Macd(val line: List<Double?>, val signal: List<Double?>, val histogram: List<Double?>)

    fun macd(closes: List<Double>, fast: Int = 12, slow: Int = 26, signalPeriod: Int = 9): Macd? {
        if (closes.size < slow + signalPeriod) return null
        val fastLine = ema(closes, fast) ?: return null
        val slowLine = ema(closes, slow) ?: return null
        val line = closes.indices.map { i ->
            if (fastLine[i] != null && slowLine[i] != null) fastLine[i]!! - slowLine[i]!! else null
        }
        val first = line.indexOfFirst { it != null }
        val raw = line.filterNotNull()
        val rawSignal = ema(raw, signalPeriod)
        val signal = MutableList<Double?>(closes.size) { null }
        if (rawSignal != null) rawSignal.forEachIndexed { i, value -> if (value != null) signal[first + i] = value }
        val histogram = closes.indices.map { i ->
            if (line[i] != null && signal[i] != null) line[i]!! - signal[i]!! else null
        }
        return Macd(line, signal, histogram)
    }

    data class Bollinger(
        val upper: List<Double?>,
        val mid: List<Double?>,
        val lower: List<Double?>,
        val bandwidth: List<Double?>,
    )

    fun bollinger(closes: List<Double>, period: Int = 20, mult: Double = 2.0): Bollinger? {
        val mid = sma(closes, period) ?: return null
        val upper = MutableList<Double?>(closes.size) { null }
        val lower = MutableList<Double?>(closes.size) { null }
        val bandwidth = MutableList<Double?>(closes.size) { null }
        for (i in period - 1 until closes.size) {
            val mean = mid[i] ?: continue
            var sumSq = 0.0
            for (j in i - period + 1..i) sumSq += (closes[j] - mean).pow(2)
            val sd = sqrt(sumSq / period)
            upper[i] = mean + mult * sd
            lower[i] = mean - mult * sd
            bandwidth[i] = if (mean != 0.0) (upper[i]!! - lower[i]!!) / mean else 0.0
        }
        return Bollinger(upper, mid, lower, bandwidth)
    }

    fun atr(candles: List<Candle>, period: Int = 14): List<Double?>? {
        if (candles.size < period + 1) return null
        val tr = MutableList(candles.size) { 0.0 }
        tr[0] = candles[0].high - candles[0].low
        for (i in 1 until candles.size) {
            tr[i] = max(candles[i].high - candles[i].low,
                max(abs(candles[i].high - candles[i - 1].close), abs(candles[i].low - candles[i - 1].close)))
        }
        val out = MutableList<Double?>(candles.size) { null }
        out[period] = (1..period).sumOf { tr[it] } / period
        for (i in period + 1 until candles.size) out[i] = (out[i - 1]!! * (period - 1) + tr[i]) / period
        return out
    }

    fun vwap(candles: List<Candle>, period: Int = 96): List<Double?> {
        return candles.indices.map { i ->
            val start = max(0, i - period + 1)
            var pv = 0.0
            var volume = 0.0
            for (j in start..i) {
                val typical = (candles[j].high + candles[j].low + candles[j].close) / 3
                pv += typical * candles[j].volume
                volume += candles[j].volume
            }
            if (volume > 0) pv / volume else null
        }
    }

    fun last(series: List<Double?>?): Double? = series?.asReversed()?.firstOrNull { it != null }
}
