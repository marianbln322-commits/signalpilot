package ro.signalpilot.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

object AlertNotifier {
    const val SERVICE_CHANNEL = "signalpilot_monitor"
    const val SIGNAL_CHANNEL = "signalpilot_signals_v1"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(SERVICE_CHANNEL, "Monitorizare SignalPilot", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Notificare permanentă necesară pentru monitorizarea pieței"
            setSound(null, null)
            enableVibration(false)
        })
        val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT).build()
        manager.createNotificationChannel(NotificationChannel(SIGNAL_CHANNEL, "Semnale UP/DOWN SignalPilot", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Alerte sonore pentru setup-uri SignalPilot"
            setSound(sound, attributes)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 250, 120, 250, 120, 500)
            enableLights(true)
            lightColor = Color.CYAN
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        })
    }

    fun canSendSound(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = manager.getNotificationChannel(SIGNAL_CHANNEL)
        return manager.areNotificationsEnabled() && channel != null &&
            channel.importance != NotificationManager.IMPORTANCE_NONE && channel.sound != null
    }

    fun send(context: Context, verdict: Verdict): Boolean {
        createChannels(context)
        if (!canSendSound(context)) return false
        val intent = Intent(context, MainActivity::class.java)
        val pending = PendingIntent.getActivity(context, 100, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val color = if (verdict.direction == "UP") Color.rgb(22, 199, 132) else Color.rgb(234, 57, 67)
        val notification = android.app.Notification.Builder(context, SIGNAL_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle("${verdict.symbol} ${verdict.direction} • ${verdict.interval}")
            .setContentText("${verdict.confidence} @ ${String.format(java.util.Locale.US, "%.4f", verdict.price)}")
            .setStyle(android.app.Notification.BigTextStyle().bigText("${verdict.justification}\nInvalidare: ${verdict.invalidation}"))
            .setColor(color).setAutoCancel(true).setContentIntent(pending)
            .setCategory(android.app.Notification.CATEGORY_ALARM).build()
        context.getSystemService(NotificationManager::class.java).notify((verdict.symbol + verdict.direction).hashCode(), notification)
        val vibrator = if (Build.VERSION.SDK_INT >= 31) context.getSystemService(VibratorManager::class.java).defaultVibrator
            else @Suppress("DEPRECATION") context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 250, 120, 250, 120, 500), -1))
        return true
    }
}
