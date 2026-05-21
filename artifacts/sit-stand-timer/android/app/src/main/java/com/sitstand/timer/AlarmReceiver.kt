package com.sitstand.timer

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Fires when an AlarmManager alarm triggers.
 * Shows a fullScreenIntent notification (causes Android to launch
 * AlarmFullScreenActivity over the lock screen when the device is locked,
 * or a heads-up notification when it is unlocked).
 */
class AlarmReceiver : BroadcastReceiver() {

    companion object {
        const val TAG = "AlarmDiag"
        const val CHANNEL_ID = "posture-alarm"
        const val ACTION_BOOT  = Intent.ACTION_BOOT_COMPLETED
        const val ACTION_LBOOT = "android.intent.action.LOCKED_BOOT_COMPLETED"
        private const val PREFS = "alarm_prefs"
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
            else                       -> fireAlarm(context, intent)
        }
    }

    private fun diagPrefs(context: Context) =
        context.getSharedPreferences(AlarmManagerPlugin.PREFS, Context.MODE_PRIVATE)

    // ── Fire the alarm ──────────────────────────────────────────────────────

    private fun fireAlarm(context: Context, intent: Intent) {
        val id    = intent.getIntExtra("id",    0)
        val title = intent.getStringExtra("title") ?: "Posture reminder"
        val body  = intent.getStringExtra("body")  ?: ""

        Log.i(TAG, "fireAlarm id=$id title='$title'")

        val dp = diagPrefs(context)
        dp.edit()
            .putInt(K_LAST_FIRE_ID, id)
            .putLong(K_LAST_FIRE_AT, System.currentTimeMillis())
            .putString(K_LAST_FIRE_TITLE, title)
            .putInt(K_FIRE_COUNT, dp.getInt(K_FIRE_COUNT, 0) + 1)
            .apply()

        ensureChannel(context)

        // Full-screen intent → AlarmFullScreenActivity
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

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fsPi, true)
            .setAutoCancel(false)
            .setOngoing(true)
            .setDefaults(NotificationCompat.DEFAULT_VIBRATE)
            .build()

        var notifyError: String? = null
        try {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(id, notification)
            Log.i(TAG, "notify OK id=$id")
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

        // Also start the activity directly so it appears immediately on the
        // lock screen even on devices that throttle fullScreenIntent.
        try {
            context.startActivity(fsIntent)
            Log.i(TAG, "startActivity AlarmFullScreenActivity OK id=$id")
        } catch (e: Exception) {
            Log.w(TAG, "startActivity AlarmFullScreenActivity FAILED id=$id error=${e.message}")
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

    // ── Notification channel ────────────────────────────────────────────────

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return

        val ch = NotificationChannel(
            CHANNEL_ID,
            "Posture Alarms",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description              = "Sit/Stand posture alarm reminders"
            lockscreenVisibility     = Notification.VISIBILITY_PUBLIC
            enableVibration(true)
            vibrationPattern         = longArrayOf(0, 500, 200, 500)
            setBypassDnd(true)
        }
        nm.createNotificationChannel(ch)
        Log.i(TAG, "Created notification channel $CHANNEL_ID")
    }
}
