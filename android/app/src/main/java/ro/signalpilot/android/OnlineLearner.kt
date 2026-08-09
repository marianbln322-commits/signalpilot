package ro.signalpilot.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Conservative, on-device calibration of the deterministic signal weights.
 *
 * This does not modify application code or train a black-box model. It records
 * medium/high-confidence calls, evaluates them against closed MEXC candles and
 * adjusts each technical feature inside strict bounds. All state stays local.
 */
object OnlineLearner {
    private const val PREFS = "signalpilot"
    private const val KEY = "online_learning_v1"
    private const val VERSION = 1
    private const val MIN_DECISIVE_SAMPLES = 5
    private const val MAX_PENDING = 200
    private const val MAX_COMPLETED_IDS = 500
    private const val NOISE_THRESHOLD = 0.0015 // 0.15%, avoids learning from tiny moves
    private const val MIN_MULTIPLIER = 0.75
    private const val MAX_MULTIPLIER = 1.25
    private val lock = Any()

    data class FeatureSummary(
        val key: String,
        val wins: Int,
        val losses: Int,
        val neutral: Int,
        val multiplier: Double,
    ) {
        val decisive: Int get() = wins + losses
        val hitRate: Double get() = if (decisive == 0) 0.0 else wins.toDouble() / decisive
    }

    data class Summary(
        val pending: Int,
        val resolved: Int,
        val wins: Int,
        val losses: Int,
        val neutral: Int,
        val expired: Int,
        val lastEvaluation: Long,
        val features: List<FeatureSummary>,
    ) {
        val decisive: Int get() = wins + losses
        val hitRate: Double get() = if (decisive == 0) 0.0 else wins.toDouble() / decisive
    }

    fun multipliers(context: Context): Map<String, Double> = synchronized(lock) {
        val stats = load(context).optJSONObject("features") ?: JSONObject()
        stats.keys().asSequence().associateWith { key -> multiplier(stats.optJSONObject(key)) }
    }

    /** Records each actionable source candle once, even though scans run every few seconds. */
    fun observe(context: Context, verdict: Verdict) = synchronized(lock) {
        if (verdict.direction == "NEUTRU" || verdict.confidence == "Scăzut") return@synchronized
        val sourceCandle = verdict.sourceTimes["5m"] ?: return@synchronized
        if (sourceCandle <= 0L || verdict.price <= 0.0) return@synchronized
        val horizonMinutes = if (verdict.interval.startsWith("10")) 10 else 30
        val id = "${verdict.symbol}:$sourceCandle"
        val state = load(context)
        val pending = state.getJSONArray("pending")
        val completedIds = state.getJSONArray("completedIds")
        val alreadyPending = (0 until pending.length()).any { pending.optJSONObject(it)?.optString("id") == id }
        val alreadyCompleted = (0 until completedIds.length()).any { completedIds.optString(it) == id }
        if (alreadyPending || alreadyCompleted) return@synchronized

        val expectedSide = verdict.direction.lowercase(Locale.ROOT)
        val featureKeys = verdict.signals.asSequence()
            .filter { it.side == expectedSide }
            .map { it.learningKey() }
            .distinct()
            .toList()
        if (featureKeys.isEmpty()) return@synchronized

        pending.put(JSONObject()
            .put("id", id)
            .put("symbol", verdict.symbol)
            .put("direction", verdict.direction)
            .put("entryPrice", verdict.price)
            .put("issuedAt", verdict.timestamp)
            .put("sourceCandle", sourceCandle)
            .put("dueAt", verdict.timestamp + horizonMinutes * 60_000L)
            .put("horizonMinutes", horizonMinutes)
            .put("features", JSONArray(featureKeys)))
        while (pending.length() > MAX_PENDING) {
            pending.optJSONObject(0)?.optString("id")?.takeIf { it.isNotBlank() }?.let { addCompletedId(state, it) }
            pending.remove(0)
            state.put("expired", state.optInt("expired") + 1)
        }
        save(context, state)
    }

    /** Resolves due predictions only from candles proven closed by their closeTime. */
    fun resolve(context: Context, symbol: String, candles: List<Candle>): Int = synchronized(lock) {
        val now = System.currentTimeMillis()
        val closed = candles.filter { it.closeTime <= now }.sortedBy { it.closeTime }
        if (closed.isEmpty()) return@synchronized 0

        val state = load(context)
        val pending = state.getJSONArray("pending")
        val remaining = JSONArray()
        var processedNow = 0
        for (index in 0 until pending.length()) {
            val prediction = pending.optJSONObject(index) ?: continue
            if (prediction.optString("symbol") != symbol || prediction.optLong("dueAt") > now) {
                remaining.put(prediction)
                continue
            }

            val dueAt = prediction.optLong("dueAt")
            val expired = dueAt < closed.first().openTime
            val exit = if (expired) null else closed.firstOrNull { it.closeTime >= dueAt }
            if (!expired && exit == null) {
                remaining.put(prediction)
                continue
            }

            if (expired) {
                // Missing historical coverage is not a market-neutral outcome.
                state.put("expired", state.optInt("expired") + 1)
            } else {
                val entry = prediction.optDouble("entryPrice", 0.0)
                val rawReturn = if (entry > 0.0) (exit!!.close - entry) / entry else 0.0
                val signedReturn = if (prediction.optString("direction") == "UP") rawReturn else -rawReturn
                val outcome = when {
                    signedReturn >= NOISE_THRESHOLD -> "win"
                    signedReturn <= -NOISE_THRESHOLD -> "loss"
                    else -> "neutral"
                }
                applyOutcome(state, prediction, outcome)
            }
            addCompletedId(state, prediction.optString("id"))
            state.put("lastEvaluation", now)
            processedNow++
        }
        state.put("pending", remaining)
        if (processedNow > 0) save(context, state)
        processedNow
    }

    fun summary(context: Context): Summary = synchronized(lock) {
        val state = load(context)
        val stats = state.getJSONObject("features")
        val features = stats.keys().asSequence().mapNotNull { key ->
            val item = stats.optJSONObject(key) ?: return@mapNotNull null
            FeatureSummary(
                key = key,
                wins = item.optInt("wins"),
                losses = item.optInt("losses"),
                neutral = item.optInt("neutrals"),
                multiplier = multiplier(item),
            )
        }.sortedWith(compareByDescending<FeatureSummary> { it.decisive }.thenBy { it.key }).take(8).toList()
        Summary(
            pending = state.getJSONArray("pending").length(),
            resolved = state.optInt("resolved"),
            wins = state.optInt("wins"),
            losses = state.optInt("losses"),
            neutral = state.optInt("neutrals"),
            expired = state.optInt("expired"),
            lastEvaluation = state.optLong("lastEvaluation"),
            features = features,
        )
    }

    fun readableFeature(key: String): String {
        val pieces = key.split('|')
        val id = when (pieces.getOrNull(0)) {
            "liquidity_sweep" -> "Liquidity sweep"
            "fvg_retest" -> "Retestare FVG/IFVG"
            "structure_shift" -> "Schimbare de structură"
            "trend_structure" -> "Structură HH/HL/LH/LL"
            "ema_alignment" -> "Aliniere EMA20/50"
            "rsi_divergence" -> "Divergență RSI"
            "macd_crossover" -> "Crossover MACD"
            "macd_histogram_contraction" -> "Contracție histogramă MACD"
            "bollinger_squeeze_breakout" -> "Breakout Bollinger squeeze"
            "bollinger_reversal" -> "Reversie Bollinger + RSI"
            "vwap_trend" -> "Trend VWAP"
            "stopping_volume" -> "Volum absorbție/distribuție"
            "higher_timeframe_trend" -> "Trend superior 1h"
            else -> pieces.getOrNull(0).orEmpty().replace('_', ' ')
        }
        val timeframe = pieces.getOrNull(1).orEmpty()
        val side = when (pieces.getOrNull(2)) { "up" -> "UP"; "down" -> "DOWN"; else -> "" }
        return "$id $timeframe $side".trim()
    }

    fun formatTime(timestamp: Long): String = if (timestamp <= 0L) "niciodată" else
        SimpleDateFormat("dd.MM HH:mm", Locale.getDefault()).format(Date(timestamp))

    private fun addCompletedId(state: JSONObject, id: String) {
        if (id.isBlank()) return
        val completed = state.getJSONArray("completedIds")
        if ((0 until completed.length()).none { completed.optString(it) == id }) completed.put(id)
        while (completed.length() > MAX_COMPLETED_IDS) completed.remove(0)
    }

    private fun applyOutcome(state: JSONObject, prediction: JSONObject, outcome: String) {
        val counter = when (outcome) { "win" -> "wins"; "loss" -> "losses"; else -> "neutrals" }
        state.put("resolved", state.optInt("resolved") + 1)
        state.put(counter, state.optInt(counter) + 1)
        val features = state.getJSONObject("features")
        val keys = prediction.optJSONArray("features") ?: JSONArray()
        for (index in 0 until keys.length()) {
            val key = keys.getString(index)
            val stat = features.optJSONObject(key) ?: JSONObject()
                .put("wins", 0).put("losses", 0).put("neutrals", 0)
            stat.put(counter, stat.optInt(counter) + 1)
            features.put(key, stat)
        }
    }

    private fun multiplier(stat: JSONObject?): Double {
        if (stat == null) return 1.0
        val wins = stat.optInt("wins")
        val losses = stat.optInt("losses")
        val decisive = wins + losses
        if (decisive < MIN_DECISIVE_SAMPLES) return 1.0
        // Beta(3,3) prior plus evidence shrinkage prevents early overreaction.
        val posteriorHitRate = (wins + 3.0) / (decisive + 6.0)
        val evidence = decisive.toDouble() / (decisive + 20.0)
        return (1.0 + (posteriorHitRate - 0.5) * evidence)
            .coerceIn(MIN_MULTIPLIER, MAX_MULTIPLIER)
    }

    private fun load(context: Context): JSONObject {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
        val parsed = runCatching { if (raw == null) null else JSONObject(raw) }.getOrNull()
        if (parsed?.optInt("version") == VERSION) {
            val needsRepair = parsed.optJSONArray("pending") == null ||
                parsed.optJSONArray("completedIds") == null || parsed.optJSONObject("features") == null
            val normalized = normalize(parsed)
            if (needsRepair) runCatching { save(context, normalized) }
            return normalized
        }
        return fresh()
    }

    private fun normalize(state: JSONObject): JSONObject {
        if (state.optJSONArray("pending") == null) state.put("pending", JSONArray())
        if (state.optJSONArray("completedIds") == null) state.put("completedIds", JSONArray())
        if (state.optJSONObject("features") == null) state.put("features", JSONObject())
        for (key in listOf("resolved", "wins", "losses", "neutrals", "expired", "lastEvaluation"))
            if (!state.has(key)) state.put(key, 0)
        return state
    }

    private fun fresh(): JSONObject = JSONObject()
        .put("version", VERSION)
        .put("pending", JSONArray())
        .put("completedIds", JSONArray())
        .put("features", JSONObject())
        .put("resolved", 0)
        .put("wins", 0)
        .put("losses", 0)
        .put("neutrals", 0)
        .put("expired", 0)
        .put("lastEvaluation", 0L)

    private fun save(context: Context, state: JSONObject) {
        // commit() is deliberate: pending/outcome idempotency must survive a kill.
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY, state.toString()).commit()) { "Nu s-a putut salva învățarea locală" }
    }
}
