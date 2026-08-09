package ro.signalpilot.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import org.json.JSONArray
import kotlin.math.max

class CandleChartView(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private var candles = JSONArray()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    fun setCandles(value: JSONArray?) {
        candles = value ?: JSONArray()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(Color.rgb(13, 17, 23))
        if (candles.length() < 2) return
        var high = Double.NEGATIVE_INFINITY
        var low = Double.POSITIVE_INFINITY
        for (i in 0 until candles.length()) {
            val candle = candles.getJSONObject(i)
            high = maxOf(high, candle.getDouble("high"))
            low = minOf(low, candle.getDouble("low"))
        }
        val range = max(high - low, high * .0001)
        high += range * .06
        low -= range * .06
        val top = 12f
        val bottom = height - 12f
        val usable = bottom - top
        fun y(price: Double): Float = (top + (high - price) / (high - low) * usable).toFloat()
        val step = width.toFloat() / candles.length()
        val body = (step * .58f).coerceIn(2f, 8f)
        paint.strokeWidth = 1.2f
        for (i in 0 until candles.length()) {
            val c = candles.getJSONObject(i)
            val open = c.getDouble("open")
            val close = c.getDouble("close")
            val x = i * step + step / 2
            paint.color = if (close >= open) Color.rgb(22, 199, 132) else Color.rgb(234, 57, 67)
            canvas.drawLine(x, y(c.getDouble("high")), x, y(c.getDouble("low")), paint)
            val y1 = y(maxOf(open, close))
            val y2 = y(minOf(open, close))
            canvas.drawRect(x - body / 2, y1, x + body / 2, max(y1 + 2f, y2), paint)
        }
    }
}
