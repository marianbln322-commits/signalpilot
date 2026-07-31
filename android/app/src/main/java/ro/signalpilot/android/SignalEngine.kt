package ro.signalpilot.android

import kotlin.math.abs

/** Faithful Kotlin port of the deterministic engine from commit c090a28. */
object SignalEngine {
    private data class Analysis(
        val timeframe: String,
        val signals: List<Signal>,
        val snapshot: Snapshot,
        val structure: SmartMoney.Structure,
        val sweep: SmartMoney.Sweep?,
        val gaps: SmartMoney.GapResult,
    )

    private fun rsiDivergence(candles: List<Candle>, rsi: List<Double?>): Pair<Boolean, Boolean> {
        val points = SmartMoney.swings(candles, 2)
        var bullish = false
        var bearish = false
        if (points.highs.size >= 2) {
            val a = points.highs[points.highs.lastIndex - 1]
            val b = points.highs.last()
            val ra = rsi.getOrNull(a.index)
            val rb = rsi.getOrNull(b.index)
            bearish = ra != null && rb != null && b.price > a.price && rb < ra
        }
        if (points.lows.size >= 2) {
            val a = points.lows[points.lows.lastIndex - 1]
            val b = points.lows.last()
            val ra = rsi.getOrNull(a.index)
            val rb = rsi.getOrNull(b.index)
            bullish = ra != null && rb != null && b.price < a.price && rb > ra
        }
        return bullish to bearish
    }

    private fun analyze(candles: List<Candle>, timeframe: String): Analysis {
        val closes = candles.map { it.close }
        val volumes = candles.map { it.volume }
        val rsi = Indicators.rsi(closes) ?: List(candles.size) { null }
        val macd = Indicators.macd(closes)
        val bb = Indicators.bollinger(closes)
        val ema20 = Indicators.ema(closes, 20) ?: List(candles.size) { null }
        val ema50 = Indicators.ema(closes, 50) ?: List(candles.size) { null }
        val volumeAverage = Indicators.sma(volumes, 20) ?: List(candles.size) { null }
        val vwap = Indicators.vwap(candles)
        val i = candles.lastIndex
        val price = closes[i]
        val rsiNow = rsi[i]
        val macdNow = macd?.line?.get(i)
        val macdSignal = macd?.signal?.get(i)
        val histNow = macd?.histogram?.get(i)
        val histPrev = macd?.histogram?.getOrNull(i - 1)
        val bbUpper = bb?.upper?.get(i)
        val bbLower = bb?.lower?.get(i)
        val bandwidth = bb?.bandwidth?.get(i)
        val ema20Now = ema20[i]
        val ema20Prev = ema20.getOrNull(i - 5) ?: ema20.getOrNull(i - 1)
        val ema50Now = ema50[i]
        val averageVolume = volumeAverage[i]
        val vwapNow = vwap[i]
        val vwapPrev = vwap.getOrNull(i - 5) ?: vwap.getOrNull(i - 1)
        val structure = SmartMoney.marketStructure(candles)
        val gaps = SmartMoney.fairValueGaps(candles)
        val sweep = SmartMoney.liquiditySweep(candles, volumeAverage = averageVolume)
        val divergence = rsiDivergence(candles, rsi)
        val bandwidthWindow = bb?.bandwidth?.takeLast(40)?.filterNotNull().orEmpty()
        val squeeze = bandwidth != null && bandwidthWindow.isNotEmpty() && bandwidth <= bandwidthWindow.min() * 1.25
        val signals = mutableListOf<Signal>()
        fun add(side: String, weight: Double, label: String, kind: String) {
            signals += Signal(side, weight, label, kind, timeframe)
        }

        if (sweep != null) {
            val weight = 3 + sweep.strength.coerceAtMost(1.5)
            add(if (sweep.type == "bullish") "up" else "down", weight,
                "Liquidity sweep ${sweep.type} (respingere${if (sweep.volumeSpike) " + volum ridicat" else ""})", "fast")
        }
        gaps.retest?.let {
            add(if (it.effectiveType == "bullish") "up" else "down", 2.5 + if (it.inverted) .5 else 0.0,
                "Retestare ${if (it.inverted) "IFVG" else "FVG"} ${it.effectiveType}", "structural")
        }
        if (structure.shift == "bullish") add("up", 2.2, "Market Structure Shift bullish (CHoCH)", "fast")
        if (structure.shift == "bearish") add("down", 2.2, "Market Structure Shift bearish (CHoCH)", "fast")
        if (structure.trend == "up") add("up", 1.5, "Structură de trend ascendent (HH/HL)", "structural")
        if (structure.trend == "down") add("down", 1.5, "Structură de trend descendent (LH/LL)", "structural")

        if (ema20Now != null && ema50Now != null) {
            if (ema20Now > ema50Now && ema20Prev != null && ema20Now > ema20Prev) {
                val near = abs(price - ema20Now) / price < .0035
                add("up", if (near) 1.8 else 1.0, "EMA20 > EMA50 în urcare${if (near) " + suport EMA20" else ""}", "structural")
            }
            if (ema20Now < ema50Now && ema20Prev != null && ema20Now < ema20Prev) {
                val near = abs(price - ema20Now) / price < .0035
                add("down", if (near) 1.8 else 1.0, "EMA20 < EMA50 în coborâre${if (near) " + rezistență EMA20" else ""}", "structural")
            }
        }
        if (divergence.first) add("up", 2.0, "Divergență bullish pe RSI", "structural")
        if (divergence.second) add("down", 2.0, "Divergență bearish pe RSI", "structural")

        if (macdNow != null && macdSignal != null && macd != null) {
            val previousLine = macd.line.getOrNull(i - 1)
            val previousSignal = macd.signal.getOrNull(i - 1)
            if (previousLine != null && previousSignal != null && previousLine <= previousSignal && macdNow > macdSignal)
                add("up", if (macdNow < 0) 1.6 else 1.1, "Crossover MACD bullish", "fast")
            if (previousLine != null && previousSignal != null && previousLine >= previousSignal && macdNow < macdSignal)
                add("down", if (macdNow > 0) 1.6 else 1.1, "Crossover MACD bearish", "fast")
        }
        if (histNow != null && histPrev != null) {
            if (histNow < 0 && histNow > histPrev) add("up", .8, "Histogramă MACD se contractă", "fast")
            if (histNow > 0 && histNow < histPrev) add("down", .8, "Histogramă MACD se contractă", "fast")
        }
        if (squeeze && bbUpper != null && price > bbUpper && averageVolume != null && volumes[i] > averageVolume * 1.5)
            add("up", 2.5, "Breakout din Bollinger Squeeze cu volum", "fast")
        if (squeeze && bbLower != null && price < bbLower && averageVolume != null && volumes[i] > averageVolume * 1.5)
            add("down", 2.5, "Breakdown din Bollinger Squeeze cu volum", "fast")
        if (bbLower != null && price <= bbLower && rsiNow != null && rsiNow < 32 && structure.trend != "down")
            add("up", 1.4, "Bandă Bollinger inferioară + RSI supravândut (reversie)", "fast")
        if (bbUpper != null && price >= bbUpper && rsiNow != null && rsiNow > 68 && structure.trend != "up" && divergence.second)
            add("down", 1.4, "Bandă Bollinger superioară + RSI + divergență", "fast")
        if (vwapNow != null) {
            if (price > vwapNow && vwapPrev != null && vwapNow > vwapPrev) add("up", 1.0, "Preț peste VWAP în urcare", "structural")
            if (price < vwapNow && vwapPrev != null && vwapNow < vwapPrev) add("down", 1.0, "Preț sub VWAP în coborâre", "structural")
        }
        if (averageVolume != null && volumes[i] > averageVolume * 1.8) {
            val candle = candles[i]
            val lowerWick = minOf(candle.close, candle.open) - candle.low
            val upperWick = candle.high - maxOf(candle.close, candle.open)
            val body = abs(candle.close - candle.open)
            if (lowerWick > body && lowerWick > upperWick) add("up", 1.6, "Volum de oprire / absorbție la minim", "fast")
            if (upperWick > body && upperWick > lowerWick) add("down", 1.6, "Volum de distribuție la maxim", "fast")
        }

        return Analysis(timeframe, signals, Snapshot(
            price = price,
            rsi = rsiNow,
            macdHistogram = histNow,
            ema20 = ema20Now,
            ema50 = ema50Now,
            trend = structure.trend,
            sweep = sweep?.type,
            aboveVwap = vwapNow?.let { price > it },
        ), structure, sweep, gaps)
    }

    fun decide(symbol: String, market: Map<String, List<Candle>>, orderFlow: OrderFlow?): Verdict {
        val analyses = mutableListOf<Analysis>()
        market["5m"]?.takeIf { it.size >= 60 }?.let { analyses += analyze(it, "5m") }
        market["15m"]?.takeIf { it.size >= 60 }?.let { analyses += analyze(it, "15m") }
        val all = analyses.flatMap { it.signals }.toMutableList()
        var higherTrend: String? = null
        market["60m"]?.takeIf { it.size >= 60 }?.let { candles ->
            val closes = candles.map { it.close }
            val e20 = Indicators.last(Indicators.ema(closes, 20))
            val e50 = Indicators.last(Indicators.ema(closes, 50))
            if (e20 != null && e50 != null) {
                higherTrend = if (e20 > e50) "up" else "down"
                all += Signal(higherTrend!!, 1.5, "Aliniere cu trendul 1h (${if (higherTrend == "up") "ascendent" else "descendent"})", "structural", "1h")
            }
        }
        val up = all.filter { it.side == "up" }.sumOf { it.weight }
        val down = all.filter { it.side == "down" }.sumOf { it.weight }
        val net = up - down
        var direction = when {
            net > .8 -> "UP"
            net < -.8 -> "DOWN"
            else -> "NEUTRU"
        }
        val side = when (direction) { "UP" -> "up"; "DOWN" -> "down"; else -> null }
        val winning = all.filter { it.side == side }.sortedByDescending { it.weight }
        val trigger = Regex("sweep|squeeze|structure shift|fvg|divergen|crossover|absorb|distribu|reversie|band", RegexOption.IGNORE_CASE)
        val hasTrigger = winning.any { trigger.containsMatchIn(it.label) }
        val noTrigger = direction != "NEUTRU" && !hasTrigger
        if (noTrigger) direction = "NEUTRU"
        val fast = winning.filter { it.kind == "fast" }.sumOf { it.weight }
        val structural = winning.filter { it.kind != "fast" }.sumOf { it.weight }
        val interval = if (direction == "NEUTRU") "30 minute" else if (fast >= structural) "10 minute" else "30 minute"
        val confidence = when {
            direction == "NEUTRU" -> "Scăzut"
            abs(net) >= 4.5 && winning.size >= 3 -> "Ridicat"
            abs(net) >= 2.5 && winning.size >= 2 -> "Mediu"
            else -> "Scăzut"
        }
        val anchor = analyses.find { it.timeframe == "15m" } ?: analyses.firstOrNull()
        val invalidation = when {
            anchor?.sweep != null && direction == "UP" -> "Închidere sub wick-ul sweep ${fmt(anchor.sweep.wickExtreme)} invalidează scenariul."
            anchor?.sweep != null && direction == "DOWN" -> "Închidere peste wick-ul sweep ${fmt(anchor.sweep.wickExtreme)} invalidează scenariul."
            anchor?.gaps?.retest != null && direction == "UP" -> "Închidere sub baza FVG ${fmt(anchor.gaps.retest.bottom)} invalidează scenariul."
            anchor?.gaps?.retest != null && direction == "DOWN" -> "Închidere peste vârful FVG ${fmt(anchor.gaps.retest.top)} invalidează scenariul."
            anchor?.snapshot?.ema20 != null && direction == "UP" -> "Închidere sub EMA20 ${fmt(anchor.snapshot.ema20)} invalidează scenariul."
            anchor?.snapshot?.ema20 != null && direction == "DOWN" -> "Închidere peste EMA20 ${fmt(anchor.snapshot.ema20)} invalidează scenariul."
            else -> "Structură neclară — fără nivel ferm de invalidare."
        }
        val justification = if (direction == "NEUTRU") {
            if (noTrigger) "Există context direcțional, dar lipsește un trigger real. Se așteaptă sweep, squeeze, shift de structură, FVG sau divergență."
            else "Grafic contradictoriu, fără momentum direcțional clar. Se recomandă așteptarea."
        } else {
            "Confluență $direction pe ${winning.size} semnale: ${winning.take(4).joinToString("; ") { "${it.label} (${it.timeframe})" }}."
        }
        val hour = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).get(java.util.Calendar.HOUR_OF_DAY)
        val sniper = sniperEligibility(direction, winning, hour, listOf(6,7,8,9,13,14,15,16,17), false)
        return Verdict(
            symbol = symbol,
            direction = direction,
            interval = interval,
            confidence = confidence,
            justification = justification,
            invalidation = invalidation,
            price = analyses.lastOrNull()?.snapshot?.price ?: market["5m"]?.lastOrNull()?.close ?: 0.0,
            signals = winning,
            snapshots = analyses.associate { it.timeframe to it.snapshot },
            chart = market["5m"].orEmpty().takeLast(80),
            sniperEligible = sniper.first,
            sniperReason = sniper.second,
            orderFlow = orderFlow,
            orderFlowAgreement = orderFlowAgreement(direction, orderFlow),
        )
    }

    fun orderFlowAgreement(direction: String, orderFlow: OrderFlow?): String {
        if (orderFlow == null || orderFlow.state == "neutru" || direction == "NEUTRU") return "neutru"
        val bullish = orderFlow.state == "buy"
        return when (direction) {
            "UP" -> if (bullish) "confirmă" else "conflict"
            "DOWN" -> if (bullish) "conflict" else "confirmă"
            else -> "neutru"
        }
    }

    fun sniperEligibility(direction: String, signals: List<Signal>, hourUtc: Int, activeHours: List<Int>, requireVolume: Boolean): Pair<Boolean, String> {
        if (direction == "NEUTRU") return false to "fără direcție clară"
        val sweep = signals.find { it.label.contains("liquidity sweep", true) }
            ?: return false to "niciun liquidity sweep pe direcția semnalului"
        if (requireVolume && !sweep.label.contains("volum ridicat", true)) return false to "sweep fără confirmare de volum"
        if (activeHours.isNotEmpty() && hourUtc !in activeHours) return false to "în afara orelor active ($hourUtc:00 UTC)"
        return true to "Sniper A+: ${sweep.label} [${sweep.timeframe}]"
    }

    private fun fmt(value: Double?): String = if (value == null) "—" else String.format(java.util.Locale.US, "%.2f", value)
}
