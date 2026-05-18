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
import androidx.core.app.NotificationCompat

/**
 * Fires when an AlarmManager alarm triggers.
 * Shows a fullScreenIntent notification (causes Android to launch
 * AlarmFullScreenActivity over the lock screen when the device is locked,
 * or a heads-up notification when it is unlocked).
 */
class AlarmReceiver : BroadcastReceiver() {

    companion object {
        const val CHANNEL_ID = "posture-alarm"
        const val ACTION_BOOT  = Intent.ACTION_BOOT_COMPLETED
        const val ACTION_LBOOT = "android.intent.action.LOCKED_BOOT_COMPLETED"
        private const val PREFS = "alarm_prefs"

        // Fixed display notification IDs — all posture alarms share one slot so
        // each new reminder replaces the previous one instead of stacking.
        // Bladder alarms get their own slot so they never clobber a posture alert.
        const val POSTURE_NOTIF_ID = 1
        const val BLADDER_NOTIF_ID = 2

        // Alarm ID ranges (must match nativeNotifications.ts on the JS side)
        //   2000–2010  sitting reminders
        //   3000–3010  standing reminders
        //   4000–4001  bladder + bladder-snooze
        //   501, 502   posture/bladder snooze (notifId + 500)
        fun displayNotifId(alarmId: Int) =
            if (alarmId >= 4000) BLADDER_NOTIF_ID else POSTURE_NOTIF_ID
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_BOOT, ACTION_LBOOT -> rescheduleOnBoot(context)
            else                       -> fireAlarm(context, intent)
        }
    }

    // ── Fire the alarm ──────────────────────────────────────────────────────

    private fun fireAlarm(context: Context, intent: Intent) {
        val id    = intent.getIntExtra("id",    0)
        val title = intent.getStringExtra("title") ?: "Posture reminder"
        val body  = intent.getStringExtra("body")  ?: ""

        // Use a fixed display notification ID per type so each new alarm
        // *replaces* the previous one rather than stacking in the drawer.
        val notifId = displayNotifId(id)

        ensureChannel(context)

        // Full-screen intent → AlarmFullScreenActivity
        // Pass notifId (not the scheduling id) so the activity cancels the
        // correct visible notification on Dismiss/Snooze.
        val fsIntent = Intent(context, AlarmFullScreenActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("id",       notifId)   // used by activity to cancel notification
            putExtra("alarm_id", id)        // original scheduling id (for snooze chain)
            putExtra("title",    title)
            putExtra("body",     body)
        }
        val fsPi = PendingIntent.getActivity(
            context, notifId, fsIntent,
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

        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(notifId, notification)

        // Also start the activity directly so it appears immediately on the
        // lock screen even on devices that throttle fullScreenIntent.
        try { context.startActivity(fsIntent) } catch (_: Exception) {}
    }

    // ── Boot-time rescheduling ──────────────────────────────────────────────
    // After a reboot all AlarmManager alarms are cleared. We persist a list
    // of pending alarm IDs + fire-times to SharedPreferences so we can
    // restore them after the device restarts.

    private fun rescheduleOnBoot(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val am    = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val now   = System.currentTimeMillis()

        prefs.all.forEach { (key, value) ->
            if (!key.startsWith("alarm_")) return@forEach
            val parts = (value as? String)?.split("|") ?: return@forEach
            if (parts.size < 3) return@forEach

            val id       = parts[0].toIntOrNull() ?: return@forEach
            val triggerAt = parts[1].toLongOrNull() ?: return@forEach
            val title    = parts[2]
            val body     = if (parts.size > 3) parts[3] else ""

            if (triggerAt <= now) {
                // Already past — fire immediately with a short delay
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi)
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
    }
}
