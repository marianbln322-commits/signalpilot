package ro.signalpilot.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object StateStore {
    private const val PREFS = "signalpilot"
    private const val KEY_STATE = "state"
    private const val KEY_ALERTS = "alerts"

    fun saveVerdict(context: Context, verdict: Verdict) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val state = JSONObject(prefs.getString(KEY_STATE, "{}") ?: "{}")
        state.put(verdict.symbol, verdict.toJson())
        prefs.edit().putString(KEY_STATE, state.toString()).putLong("last_scan", System.currentTimeMillis()).apply()
    }

    fun latest(context: Context): List<JSONObject> {
        val source = JSONObject(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_STATE, "{}") ?: "{}")
        return source.keys().asSequence().map { source.getJSONObject(it) }.sortedBy { it.optString("symbol") }.toList()
    }

    fun addAlert(context: Context, verdict: Verdict) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val old = JSONArray(prefs.getString(KEY_ALERTS, "[]") ?: "[]")
        val next = JSONArray().put(verdict.toJson())
        for (i in 0 until minOf(old.length(), 49)) next.put(old.getJSONObject(i))
        prefs.edit().putString(KEY_ALERTS, next.toString()).apply()
    }

    fun alerts(context: Context): List<JSONObject> {
        val array = JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ALERTS, "[]") ?: "[]")
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    fun setRunning(context: Context, running: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", running).apply()
    }

    fun isEnabled(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)
    fun lastScan(context: Context): Long = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("last_scan", 0)
    fun setError(context: Context, message: String?) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("error", message).apply()
    fun error(context: Context): String? = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("error", null)

    fun symbols(context: Context): List<String> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("symbols", "BTCUSDT,ETHUSDT") ?: "BTCUSDT,ETHUSDT"
        val parsed = raw.split(',').map { it.trim().uppercase().replace(Regex("[^A-Z0-9]"), "") }
            .filter { it.isNotBlank() }.distinct().take(8)
        return parsed.ifEmpty { listOf("BTCUSDT", "ETHUSDT") }
    }

    fun setSymbols(context: Context, symbols: String) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("symbols", symbols).apply()
    fun sniper(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("sniper", true)
    fun setSniper(context: Context, enabled: Boolean) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("sniper", enabled).apply()
    fun requireOrderFlow(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("require_order_flow", false)
    fun setRequireOrderFlow(context: Context, enabled: Boolean) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("require_order_flow", enabled).apply()

    fun lastAlertKey(context: Context, symbol: String): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("alert_key_$symbol", null)

    fun lastAlertTime(context: Context, symbol: String): Long =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("alert_time_$symbol", 0L)

    fun recordAlert(context: Context, symbol: String, key: String, timestamp: Long) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("alert_key_$symbol", key)
            .putLong("alert_time_$symbol", timestamp)
            .apply()

    private fun Verdict.toJson(): JSONObject = JSONObject()
        .put("symbol", symbol).put("direction", direction).put("interval", interval)
        .put("confidence", confidence).put("price", price).put("justification", justification)
        .put("invalidation", invalidation).put("sniperEligible", sniperEligible)
        .put("sniperReason", sniperReason).put("timestamp", timestamp)
        .put("orderFlow", orderFlow?.state ?: "indisponibil")
        .put("orderFlowAgreement", orderFlowAgreement)
        .put("orderPressure", orderFlow?.pressure ?: 0.0)
        .put("rsi5m", snapshots["5m"]?.rsi ?: JSONObject.NULL)
        .put("trend5m", snapshots["5m"]?.trend ?: "—")
        .put("signals", JSONArray(signals.take(5).map { it.label }))
        .put("candles", JSONArray(chart.map { c -> JSONObject()
            .put("open", c.open).put("high", c.high).put("low", c.low).put("close", c.close).put("time", c.openTime) }))
}
