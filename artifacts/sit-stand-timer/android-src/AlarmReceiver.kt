package com.sitstand.timer

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Fires when an AlarmManager alarm triggers.
 * Shows a fullScreenIntent notification (causes Android to launch
 * AlarmFullScreenActivity over the lock screen when the device is locked,
 * or a heads-up notification when it is unlocked).
 */
class AlarmReceiver : BroadcastReceiver() {

    companion object {
        const val TAG = "AlarmDiag"
        // v2 suffix forces channel recreation on Samsung devices that cache
        // the old channel (vibrate-only) in the system notification DB even
        // after a full app uninstall.  Channel sound/vibration settings are
        // locked once created; a new ID is the only way to change them.
        const val CHANNEL_ID        = "posture-alarm-v2"
        const val CHANNEL_ID_SILENT = "posture-alarm-silent-v2"
        const val ACTION_BOOT    = Intent.ACTION_BOOT_COMPLETED
        const val ACTION_LBOOT   = "android.intent.action.LOCKED_BOOT_COMPLETED"
        const val ACTION_DISMISS = "com.sitstand.timer.DISMISS_ALARM"
        const val ACTION_SNOOZE  = "com.sitstand.timer.SNOOZE_ALARM"
        private const val PREFS  = "alarm_prefs"
        // Diagnostic keys (written into AlarmManagerPlugin's prefs file)
        const val K_LAST_FIRE_ID       = "last_fire_id"
        const val K_LAST_FIRE_AT       = "last_fire_at"
        const val K_LAST_FIRE_TITLE    = "last_fire_title"
        const val K_LAST_NOTIFY_ERROR  = "last_notify_error"
        const val K_FIRE_COUNT         = "fire_count"
        const val K_NOTIFY_COUNT       = "notify_count"
        const val K_NOTIFY_FAIL_COUNT  = "notify_fail_count"
    }

    override fun onReceive(context: Context, intent: Intent) {
        Log.i(TAG, "AlarmReceiver.onReceive action=${intent.action} extras=${intent.extras?.keySet()}")
        when (intent.action) {
            ACTION_BOOT, ACTION_LBOOT -> rescheduleOnBoot(context)
            ACTION_DISMISS            -> dismissAlarm(context, intent)
            ACTION_SNOOZE             -> snoozeAlarm(context, intent)
            else                      -> fireAlarm(context, intent)
        }
    }

    private fun diagPrefs(context: Context) =
        context.getSharedPreferences(AlarmManagerPlugin.PREFS, Context.MODE_PRIVATE)

    // ── Fire the alarm ──────────────────────────────────────────────────────

    private fun fireAlarm(context: Context, intent: Intent) {
        val id     = intent.getIntExtra("id",    0)
        val title  = intent.getStringExtra("title") ?: "Posture reminder"
        val body   = intent.getStringExtra("body")  ?: ""
        val silent = intent.getBooleanExtra("silent", false)

        Log.i(TAG, "fireAlarm id=$id title='$title' silent=$silent")

        val dp = diagPrefs(context)
        dp.edit()
            .putInt(K_LAST_FIRE_ID, id)
            .putLong(K_LAST_FIRE_AT, System.currentTimeMillis())
            .putString(K_LAST_FIRE_TITLE, title)
            .putInt(K_FIRE_COUNT, dp.getInt(K_FIRE_COUNT, 0) + 1)
            .apply()

        ensureChannel(context)
        ensureChannelSilent(context)

        val channelId = if (silent) CHANNEL_ID_SILENT else CHANNEL_ID

        // Tap notification → open the app
        val openIntent = context.packageManager
            .getLaunchIntentForPackage(context.packageName)
            ?.apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val contentPi = PendingIntent.getActivity(
            context, id + 10_000, openIntent ?: Intent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Full-screen intent → AlarmFullScreenActivity (fires on lock screen)
        val fsIntent = Intent(context, AlarmFullScreenActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("id",    id)
            putExtra("title", title)
            putExtra("body",  body)
        }
        val fsPi = PendingIntent.getActivity(
            context, id, fsIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Dismiss action — cancels the notification immediately
        val dismissIntent = Intent(context, AlarmReceiver::class.java).apply {
            action = ACTION_DISMISS
            putExtra("id", id)
        }
        val dismissPi = PendingIntent.getBroadcast(
            context, id + 20_000, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Snooze action — reschedules 5 minutes from now
        val snoozeIntent = Intent(context, AlarmReceiver::class.java).apply {
            action = ACTION_SNOOZE
            putExtra("id",     id)
            putExtra("title",  title)
            putExtra("body",   body)
            putExtra("silent", silent)
        }
        val snoozePi = PendingIntent.getBroadcast(
            context, id + 30_000, snoozeIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val defaults = if (silent)
            NotificationCompat.DEFAULT_VIBRATE
        else
            NotificationCompat.DEFAULT_VIBRATE or NotificationCompat.DEFAULT_SOUND

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(contentPi)
            .setFullScreenIntent(fsPi, true)
            .setAutoCancel(false)
            .setOngoing(true)
            .setDefaults(defaults)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPi)
            .addAction(android.R.drawable.ic_menu_recent_history,     "Snooze 5 min", snoozePi)
            .build()

        var notifyError: String? = null
        try {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(id, notification)
            Log.i(TAG, "notify OK id=$id channelId=$channelId")
            dp.edit()
                .putInt(K_NOTIFY_COUNT, dp.getInt(K_NOTIFY_COUNT, 0) + 1)
                .putString(K_LAST_NOTIFY_ERROR, "")
                .apply()
        } catch (e: Exception) {
            notifyError = "${e.javaClass.simpleName}: ${e.message}"
            Log.e(TAG, "notify FAILED id=$id error=$notifyError", e)
            dp.edit()
                .putInt(K_NOTIFY_FAIL_COUNT, dp.getInt(K_NOTIFY_FAIL_COUNT, 0) + 1)
                .putString(K_LAST_NOTIFY_ERROR, notifyError)
                .apply()
        }
    }

    // ── Notification action handlers ────────────────────────────────────────

    private fun dismissAlarm(context: Context, intent: Intent) {
        val id = intent.getIntExtra("id", 0)
        Log.i(TAG, "dismissAlarm id=$id")
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(id)
    }

    private fun snoozeAlarm(context: Context, intent: Intent) {
        val id     = intent.getIntExtra("id",    0)
        val title  = intent.getStringExtra("title") ?: "Posture reminder"
        val body   = intent.getStringExtra("body")  ?: ""
        val silent = intent.getBooleanExtra("silent", false)

        Log.i(TAG, "snoozeAlarm id=$id — rescheduling in 5 min")

        // Cancel the current notification
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(id)

        // Schedule a new alarm 5 minutes from now (use id+500 to avoid collision)
        val snoozeId = id + 500
        val alarmIntent = Intent(context, AlarmReceiver::class.java).apply {
            putExtra("id",     snoozeId)
            putExtra("title",  "⏱ Snoozed: $title")
            putExtra("body",   body)
            putExtra("silent", silent)
        }
        val pi = PendingIntent.getBroadcast(
            context, snoozeId, alarmIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val am       = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = System.currentTimeMillis() + 5 * 60_000L
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            }
            Log.i(TAG, "snooze alarm scheduled id=$snoozeId triggerAt=$triggerAt")
        } catch (e: Exception) {
            Log.w(TAG, "snooze schedule failed: ${e.message}")
        }
    }

    // ── Boot-time rescheduling ──────────────────────────────────────────────

    private fun rescheduleOnBoot(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val am    = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val now   = System.currentTimeMillis()

        Log.i(TAG, "rescheduleOnBoot starting; ${prefs.all.size} pref entries")
        prefs.all.forEach { (key, value) ->
            if (!key.startsWith("alarm_")) return@forEach
            val parts = (value as? String)?.split("|") ?: return@forEach
            if (parts.size < 3) return@forEach

            val id       = parts[0].toIntOrNull() ?: return@forEach
            val triggerAt = parts[1].toLongOrNull() ?: return@forEach
            val title    = parts[2]
            val body     = if (parts.size > 3) parts[3] else ""

            if (triggerAt <= now) {
                scheduleAlarm(context, am, id, title, body, now + 5_000)
            } else {
                scheduleAlarm(context, am, id, title, body, triggerAt)
            }
        }
    }

    private fun scheduleAlarm(
        context: Context, am: AlarmManager,
        id: Int, title: String, body: String, triggerAt: Long
    ) {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            putExtra("id",    id)
            putExtra("title", title)
            putExtra("body",  body)
        }
        val pi = PendingIntent.getBroadcast(
            context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            }
            Log.i(TAG, "reschedule id=$id triggerAt=$triggerAt OK")
        } catch (e: Exception) {
            Log.w(TAG, "reschedule id=$id triggerAt=$triggerAt FAILED: ${e.message}")
        }
    }

    // ── Notification channels ───────────────────────────────────────────────

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return

        // USAGE_ALARM: plays on the alarm volume stream, bypasses DND /
        // silent / vibrate mode, and honours the user's alarm volume level.
        // TYPE_ALARM gives the louder, persistent alarm ringtone rather than
        // the quieter notification blip.
        val alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val audioAttr  = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        val ch = NotificationChannel(
            CHANNEL_ID,
            "Posture Alarms",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description          = "Sit/Stand posture alarm reminders (with sound)"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            enableVibration(true)
            vibrationPattern     = longArrayOf(0, 500, 200, 500)
            setSound(alarmSound, audioAttr)
            setBypassDnd(true)
        }
        nm.createNotificationChannel(ch)
        Log.i(TAG, "Created notification channel $CHANNEL_ID (alarm-stream sound)")
    }

    private fun ensureChannelSilent(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID_SILENT) != null) return

        val ch = NotificationChannel(
            CHANNEL_ID_SILENT,
            "Posture Alarms (Silent)",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description          = "Sit/Stand posture alarm reminders (vibrate only)"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            enableVibration(true)
            vibrationPattern     = longArrayOf(0, 500, 200, 500)
            setSound(null, null)
            setBypassDnd(true)
        }
        nm.createNotificationChannel(ch)
        Log.i(TAG, "Created notification channel $CHANNEL_ID_SILENT (silent)")
    }
}
