package ro.signalpilot.android

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class SignalService : Service() {
    companion object {
        const val ACTION_UPDATE = "ro.signalpilot.android.UPDATE"
        const val ACTION_STOP = "ro.signalpilot.android.STOP"
        private const val FOREGROUND_ID = 3010
        private const val SCAN_SECONDS = 8L // original SignalPilot cadence
    }

    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var task: ScheduledFuture<*>? = null
    private val scanRunning = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        AlertNotifier.createChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            StateStore.setRunning(this, false)
            cancelRestartAlarm()
            stopSelf()
            return START_NOT_STICKY
        }
        StateStore.setRunning(this, true)
        startForeground(FOREGROUND_ID, statusNotification("Pornire monitorizare MEXC…"))
        if (task == null || task?.isCancelled == true) {
            task = scheduler.scheduleWithFixedDelay(::scanAllSafely, 0, SCAN_SECONDS, TimeUnit.SECONDS)
        }
        return START_STICKY
    }

    private fun scanAllSafely() {
        if (!scanRunning.compareAndSet(false, true)) return
        val power = getSystemService(PowerManager::class.java)
        try {
            val symbols = StateStore.symbols(this)
            var completed = 0
            for (symbol in symbols) {
                // Protect only the active network/analysis operation. This scales
                // with the configured symbol count instead of expiring mid-cycle.
                val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SignalPilot:MarketScan:$symbol")
                try {
                    lock.acquire(45_000)
                    val market = MexcClient.fetchMarket(symbol)
                    val orderFlow = MexcClient.fetchOrderFlow(symbol)
                    val verdict = SignalEngine.decide(symbol, market, orderFlow)
                    StateStore.saveVerdict(this, verdict)
                    StateStore.setError(this, null)
                    val oldFingerprint = StateStore.signalFingerprint(this, symbol)
                    val newFingerprint = signalFingerprint(verdict)
                    val alertDue = shouldAlert(verdict, oldFingerprint, newFingerprint)
                    val delivered = if (alertDue) AlertNotifier.send(this, verdict) else false
                    if (delivered) StateStore.addAlert(this, verdict)
                    // Persist every normal state transition, including NEUTRU.
                    // If an audible alert was due but could not be delivered, keep
                    // the old fingerprint so it is retried after sound is restored.
                    if (!alertDue || delivered) StateStore.setSignalFingerprint(this, symbol, newFingerprint)
                    completed++
                    sendBroadcast(Intent(ACTION_UPDATE).setPackage(packageName))
                } catch (error: Exception) {
                    StateStore.setError(this, "$symbol: ${error.message ?: error.javaClass.simpleName}")
                } finally {
                    if (lock.isHeld) lock.release()
                }
            }
            val label = if (completed == symbols.size) "Live • $completed simboluri • scan 8s" else "Feed parțial • $completed/${symbols.size}"
            getSystemService(android.app.NotificationManager::class.java).notify(FOREGROUND_ID, statusNotification(label))
            sendBroadcast(Intent(ACTION_UPDATE).setPackage(packageName))
        } finally {
            scanRunning.set(false)
        }
    }

    private fun signalFingerprint(verdict: Verdict): String {
        val base = if (StateStore.sniper(this)) {
            "sniper:${verdict.sniperEligible}:${verdict.direction}"
        } else {
            "normal:${verdict.direction}:${verdict.confidence}"
        }
        return if (StateStore.requireOrderFlow(this)) "$base:${verdict.orderFlowAgreement}" else base
    }

    private fun shouldAlert(now: Verdict, oldFingerprint: String?, newFingerprint: String): Boolean {
        if (StateStore.requireOrderFlow(this) && now.orderFlowAgreement == "conflict") return false
        if (StateStore.sniper(this)) return now.sniperEligible && oldFingerprint != newFingerprint
        val rank = mapOf("Scăzut" to 1, "Mediu" to 2, "Ridicat" to 3)
        val valid = now.direction != "NEUTRU" && (rank[now.confidence] ?: 0) >= 2
        return valid && oldFingerprint != newFingerprint
    }

    private fun statusNotification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 2, Intent(this, SignalService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).apply { timeZone = TimeZone.getDefault() }.format(Date())
        return Notification.Builder(this, AlertNotifier.SERVICE_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("SignalPilot monitorizează 24/7")
            .setContentText("$text • $time")
            .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Oprește", stop).build())
            .build()
    }

    private fun restartIntent(): PendingIntent = PendingIntent.getForegroundService(
        this, 9, Intent(this, SignalService::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    private fun cancelRestartAlarm() {
        val pending = restartIntent()
        getSystemService(AlarmManager::class.java).cancel(pending)
        pending.cancel()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (StateStore.isEnabled(this)) {
            val restart = restartIntent()
            val alarm = getSystemService(AlarmManager::class.java)
            // Best-effort recovery: Android/OEM power policy may defer this.
            alarm.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 60_000, restart)
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        task?.cancel(true)
        task = null
        scheduler.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
