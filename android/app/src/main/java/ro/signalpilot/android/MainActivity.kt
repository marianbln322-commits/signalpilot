package ro.signalpilot.android

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var cards: LinearLayout
    private lateinit var alerts: LinearLayout
    private lateinit var symbolsInput: EditText
    private lateinit var sniper: CheckBox
    private lateinit var requireOrderFlow: CheckBox
    private val handler = Handler(Looper.getMainLooper())
    private val refreshTask = object : Runnable {
        override fun run() { render(); handler.postDelayed(this, 3_000) }
    }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = render()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AlertNotifier.createChannels(this)
        requestNotificationPermission()
        setContentView(buildUi())
        symbolsInput.setText(StateStore.symbols(this).joinToString(","))
        sniper.isChecked = StateStore.sniper(this)
        requireOrderFlow.isChecked = StateStore.requireOrderFlow(this)
        render()
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(SignalService.ACTION_UPDATE)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, RECEIVER_NOT_EXPORTED) else @Suppress("DEPRECATION") registerReceiver(receiver, filter)
        handler.post(refreshTask)
    }

    override fun onStop() {
        handler.removeCallbacks(refreshTask)
        runCatching { unregisterReceiver(receiver) }
        super.onStop()
    }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(14), dp(14), dp(28)); setBackgroundColor(Color.rgb(8, 11, 16)) }
        root.addView(text("SIGNALPILOT", 25, Color.WHITE, true))
        root.addView(text("ANDROID • MOTOR ORIGINAL c090a28 • MEXC LIVE", 11, Color.rgb(77, 163, 255), true))
        status = text("Oprit", 14, Color.LTGRAY, true).apply { setPadding(0, dp(14), 0, dp(10)) }
        root.addView(status)

        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        actions.addView(button("PORNEȘTE 24/7", Color.rgb(22, 130, 95)) { saveSettings(); startMonitor() }, weight())
        actions.addView(button("OPREȘTE", Color.rgb(150, 45, 53)) { stopMonitor() }, weight())
        root.addView(actions)
        root.addView(button("Permite rularea fără restricții de baterie", Color.rgb(44, 63, 88)) { requestBatteryExemption() }, full())
        root.addView(button("TESTEAZĂ SUNETUL ȘI VIBRAȚIA", Color.rgb(82, 63, 125)) { testSound() }, full())

        root.addView(section("SETĂRI"))
        symbolsInput = EditText(this).apply {
            setTextColor(Color.WHITE); setHintTextColor(Color.GRAY); hint = "BTCUSDT,ETHUSDT"
            setSingleLine(true); setPadding(dp(12), dp(8), dp(12), dp(8)); background = rounded(Color.rgb(22, 28, 38), Color.rgb(47, 58, 74))
        }
        root.addView(symbolsInput, full())
        sniper = CheckBox(this).apply {
            text = "Mod Sniper original (doar liquidity sweep în orele active)"
            setTextColor(Color.LTGRAY); buttonTintList = android.content.res.ColorStateList.valueOf(Color.rgb(77, 163, 255))
        }
        root.addView(sniper)
        requireOrderFlow = CheckBox(this).apply {
            text = "Blochează alerta când order flow este în conflict"
            setTextColor(Color.LTGRAY); buttonTintList = android.content.res.ColorStateList.valueOf(Color.rgb(77, 163, 255))
        }
        root.addView(requireOrderFlow)
        root.addView(text("Debifează Sniper pentru alerte UP/DOWN de la încredere Mediu. Setarea originală Sniper este activată implicit; veto-ul order flow este opțional.", 11, Color.GRAY, false))
        root.addView(button("SALVEAZĂ SETĂRILE", Color.rgb(42, 74, 110)) { saveSettings(); render() }, full())

        root.addView(section("PIAȚĂ LIVE"))
        cards = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(cards)
        root.addView(section("ALERTE SONORE RECENTE"))
        alerts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(alerts)
        root.addView(text("Aplicația oferă analiză și alerte, nu plasează ordine. Rezultatele trecute nu garantează rezultate viitoare. Pentru 24/7 lasă notificarea permanentă activă și exclude aplicația din optimizarea bateriei.", 11, Color.GRAY, false).apply { setPadding(0, dp(16), 0, 0) })

        return ScrollView(this).apply { addView(root) }
    }

    private fun saveSettings() {
        StateStore.setSymbols(this, symbolsInput.text.toString())
        StateStore.setSniper(this, sniper.isChecked)
        StateStore.setRequireOrderFlow(this, requireOrderFlow.isChecked)
    }

    private fun startMonitor() {
        if (!ensureSoundAlertsEnabled()) return
        StateStore.setRunning(this, true)
        val intent = Intent(this, SignalService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        render()
    }

    private fun stopMonitor() {
        StateStore.setRunning(this, false)
        startService(Intent(this, SignalService::class.java).setAction(SignalService.ACTION_STOP))
        render()
    }

    private fun render() {
        val enabled = StateStore.isEnabled(this)
        val last = StateStore.lastScan(this)
        val age = if (last > 0) (System.currentTimeMillis() - last) / 1000 else -1
        val error = StateStore.error(this)
        val soundReady = hasSoundAlerts()
        status.text = when {
            enabled && !soundReady -> "⚠ PORNIT, DAR ALERTELE SONORE SUNT DEZACTIVATE"
            enabled && age in 0..30 -> "● LIVE 24/7 • ultima scanare acum ${age}s • interval 8s"
            enabled -> "● PORNIT • aștept date MEXC${if (error != null) " • $error" else ""}"
            else -> "○ MONITORIZARE OPRITĂ"
        }
        status.setTextColor(if (enabled && age in 0..30) Color.rgb(22, 199, 132) else if (enabled) Color.rgb(240, 180, 41) else Color.GRAY)

        cards.removeAllViews()
        val latest = StateStore.latest(this)
        if (latest.isEmpty()) cards.addView(text("Pornește monitorizarea; primele rezultate apar după descărcarea lumânărilor MEXC.", 13, Color.GRAY, false))
        latest.forEach { cards.addView(marketCard(it)) }

        alerts.removeAllViews()
        val recent = StateStore.alerts(this).take(12)
        if (recent.isEmpty()) alerts.addView(text("Nicio alertă încă. În Sniper original, alertele sunt intenționat rare.", 13, Color.GRAY, false))
        recent.forEach { alerts.addView(alertRow(it)) }
    }

    private fun marketCard(data: JSONObject): View {
        val direction = data.optString("direction", "NEUTRU")
        val accent = when (direction) { "UP" -> Color.rgb(22, 199, 132); "DOWN" -> Color.rgb(234, 57, 67); else -> Color.GRAY }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(12), dp(12), dp(12))
            background = rounded(Color.rgb(17, 22, 31), accent); layoutParams = full(dp(10))
        }
        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        top.addView(text(data.optString("symbol"), 19, Color.WHITE, true), weight())
        top.addView(text(String.format(Locale.US, "%.4f", data.optDouble("price")), 16, Color.WHITE, true))
        box.addView(top)
        box.addView(text("$direction  ${data.optString("interval")}  •  ${data.optString("confidence")}", 18, accent, true))
        val chart = CandleChartView(this).apply { setCandles(data.optJSONArray("candles")) }
        box.addView(chart, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(175)).apply { topMargin = dp(8); bottomMargin = dp(8) })
        val rsi = if (data.isNull("rsi5m")) "—" else String.format(Locale.US, "%.1f", data.optDouble("rsi5m"))
        box.addView(text("5m: RSI $rsi • trend ${data.optString("trend5m")} • order flow ${data.optString("orderFlow")} (${data.optString("orderFlowAgreement")})", 12, Color.rgb(170, 180, 194), false))
        box.addView(text(data.optString("justification"), 13, Color.LTGRAY, false).apply { setPadding(0, dp(7), 0, 0) })
        box.addView(text("Invalidare: ${data.optString("invalidation")}", 11, Color.rgb(240, 180, 41), false).apply { setPadding(0, dp(5), 0, 0) })
        if (!data.optBoolean("sniperEligible")) box.addView(text("Sniper: ${data.optString("sniperReason")}", 11, Color.GRAY, false))
        return box
    }

    private fun alertRow(data: JSONObject): View {
        val up = data.optString("direction") == "UP"
        val color = if (up) Color.rgb(22, 199, 132) else Color.rgb(234, 57, 67)
        val time = SimpleDateFormat("dd.MM HH:mm", Locale.getDefault()).format(Date(data.optLong("timestamp")))
        return text("${if (up) "▲" else "▼"} ${data.optString("symbol")} ${data.optString("direction")} • ${data.optString("interval")} • $time", 14, color, true).apply {
            setPadding(dp(10), dp(10), dp(10), dp(10)); background = rounded(Color.rgb(17, 22, 31), Color.rgb(46, 56, 72)); layoutParams = full(dp(6))
        }
    }

    private fun testSound() {
        if (!ensureSoundAlertsEnabled()) return
        val demo = Verdict(
            symbol = "TESTUSDT", direction = "UP", interval = "10 minute", confidence = "Mediu",
            justification = "Test local pentru canalul sonor SignalPilot.",
            invalidation = "Aceasta nu este o tranzacție.", price = 1.0,
            signals = emptyList(), snapshots = emptyMap(), chart = emptyList(),
            sniperEligible = false, sniperReason = "test", orderFlow = null,
            orderFlowAgreement = "neutru",
        )
        AlertNotifier.send(this, demo)
    }

    private fun hasSoundAlerts(): Boolean = AlertNotifier.canSendSound(this)

    private fun ensureSoundAlertsEnabled(): Boolean {
        AlertNotifier.createChannels(this)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
            android.widget.Toast.makeText(this, "Permite notificările, apoi apasă din nou.", android.widget.Toast.LENGTH_LONG).show()
            return false
        }
        val ready = hasSoundAlerts()
        if (!ready) {
            android.widget.Toast.makeText(this, "Activează sunetul pentru canalul de semnale SignalPilot.", android.widget.Toast.LENGTH_LONG).show()
            val settings = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, AlertNotifier.SIGNAL_CHANNEL)
            startActivity(settings)
        }
        return ready
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
    }

    private fun requestBatteryExemption() {
        val power = getSystemService(PowerManager::class.java)
        if (!power.isIgnoringBatteryOptimizations(packageName)) {
            runCatching { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
                .onFailure { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        } else startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
    }

    private fun text(value: String, size: Int, color: Int, bold: Boolean) = TextView(this).apply {
        text = value; textSize = size.toFloat(); setTextColor(color); if (bold) setTypeface(typeface, Typeface.BOLD); setLineSpacing(0f, 1.12f)
    }
    private fun section(value: String) = text(value, 12, Color.rgb(125, 150, 180), true).apply { setPadding(0, dp(20), 0, dp(8)) }
    private fun button(value: String, color: Int, click: () -> Unit) = Button(this).apply {
        text = value; setTextColor(Color.WHITE); textSize = 12f; isAllCaps = false; background = rounded(color, color); setOnClickListener { click() }
    }
    private fun rounded(fill: Int, stroke: Int) = GradientDrawable().apply { shape = GradientDrawable.RECTANGLE; cornerRadius = dp(10).toFloat(); setColor(fill); setStroke(dp(1), stroke) }
    private fun weight() = LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(5); bottomMargin = dp(8) }
    private fun full(marginBottom: Int = dp(8)) = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = marginBottom }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
