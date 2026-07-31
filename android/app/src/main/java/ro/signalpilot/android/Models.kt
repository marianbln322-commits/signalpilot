package ro.signalpilot.android

data class Candle(
    val openTime: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Double,
    val closeTime: Long,
)

data class Signal(
    val side: String,
    val weight: Double,
    val label: String,
    val kind: String,
    val timeframe: String,
    val featureId: String,
    val baseWeight: Double = weight,
) {
    fun learningKey(): String = "$featureId|$timeframe|$side"
}

data class Snapshot(
    val price: Double,
    val rsi: Double?,
    val macdHistogram: Double?,
    val ema20: Double?,
    val ema50: Double?,
    val trend: String,
    val sweep: String?,
    val aboveVwap: Boolean?,
)

data class OrderFlow(
    val state: String,
    val pressure: Double,
)

data class Verdict(
    val symbol: String,
    val direction: String,
    val interval: String,
    val confidence: String,
    val justification: String,
    val invalidation: String,
    val price: Double,
    val signals: List<Signal>,
    val snapshots: Map<String, Snapshot>,
    val chart: List<Candle>,
    val sniperEligible: Boolean,
    val sniperReason: String,
    val orderFlow: OrderFlow?,
    val orderFlowAgreement: String,
    val sourceTimes: Map<String, Long>,
    val timestamp: Long = System.currentTimeMillis(),
)
