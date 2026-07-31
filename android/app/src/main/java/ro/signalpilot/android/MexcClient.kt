package ro.signalpilot.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors

object MexcClient {
    private const val BASE = "https://api.mexc.com"
    private val pool = Executors.newFixedThreadPool(4)

    fun fetchMarket(symbol: String): Map<String, List<Candle>> {
        val frames = listOf("5m", "15m", "60m")
        val futures = frames.associateWith { timeframe -> pool.submit(Callable { fetchCandles(symbol, timeframe, 200) }) }
        return futures.mapValues { it.value.get() }
    }

    fun fetchCandles(symbol: String, interval: String, limit: Int): List<Candle> {
        val payload = get("$BASE/api/v3/klines?symbol=${symbol.url()}&interval=${interval.url()}&limit=$limit")
        val rows = JSONArray(payload)
        return (0 until rows.length()).map { i ->
            val row = rows.getJSONArray(i)
            Candle(
                openTime = row.getLong(0),
                open = row.getString(1).toDouble(),
                high = row.getString(2).toDouble(),
                low = row.getString(3).toDouble(),
                close = row.getString(4).toDouble(),
                volume = row.getString(5).toDouble(),
                closeTime = row.getLong(6),
            )
        }
    }

    fun fetchPrice(symbol: String): Double {
        return JSONObject(get("$BASE/api/v3/ticker/price?symbol=${symbol.url()}" )).getString("price").toDouble()
    }

    fun fetchOrderFlow(symbol: String): OrderFlow? {
        return try {
            val depthFuture = pool.submit(Callable { JSONObject(get("$BASE/api/v3/depth?symbol=${symbol.url()}&limit=50")) })
            val tradesFuture = pool.submit(Callable { JSONArray(get("$BASE/api/v3/aggTrades?symbol=${symbol.url()}&limit=200")) })
            val depth = depthFuture.get()
            val trades = tradesFuture.get()
            fun quantity(rows: JSONArray): Double = (0 until rows.length()).sumOf { i ->
                rows.getJSONArray(i).getString(1).toDouble()
            }
            val bid = quantity(depth.getJSONArray("bids"))
            val ask = quantity(depth.getJSONArray("asks"))
            val bookPressure = if (bid + ask > 0) (bid - ask) / (bid + ask) else 0.0
            var buys = 0.0
            var sells = 0.0
            for (i in 0 until trades.length()) {
                val trade = trades.getJSONObject(i)
                val amount = trade.getString("q").toDouble()
                if (trade.optBoolean("m", false)) sells += amount else buys += amount
            }
            val tradePressure = if (buys + sells > 0) (buys - sells) / (buys + sells) else 0.0
            val pressure = (bookPressure + tradePressure) / 2
            OrderFlow(when { pressure > .15 -> "buy"; pressure < -.15 -> "sell"; else -> "neutru" }, pressure)
        } catch (_: Exception) { null }
    }

    private fun get(url: String): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 8_000
        connection.readTimeout = 8_000
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("User-Agent", "SignalPilot-Android/1.0")
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = BufferedReader(stream.reader()).use { it.readText() }
            if (status !in 200..299) throw IllegalStateException("MEXC HTTP $status: ${body.take(160)}")
            return body
        } finally {
            connection.disconnect()
        }
    }

    private fun String.url(): String = java.net.URLEncoder.encode(this, Charsets.UTF_8.name())
}
