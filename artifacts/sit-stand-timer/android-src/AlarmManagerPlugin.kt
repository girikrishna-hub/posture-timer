package com.sitstand.timer

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AlarmManager")
class AlarmManagerPlugin : Plugin() {

    companion object {
        private const val TAG = "AlarmDiag"
        const val PREFS = "alarm_diag"
        // Keys persisted for JS-side diagnostics
        const val K_LAST_SCHED_ID         = "last_sched_id"
        const val K_LAST_SCHED_TRIGGER_AT = "last_sched_trigger_at"
        const val K_LAST_SCHED_AT         = "last_sched_at"
        const val K_LAST_SCHED_USED_EXACT = "last_sched_used_exact"
        const val K_LAST_SCHED_ERROR      = "last_sched_error"
        const val K_LAST_SCHED_TITLE      = "last_sched_title"
        const val K_LAST_CANCEL_ID        = "last_cancel_id"
        const val K_LAST_CANCEL_AT        = "last_cancel_at"
        const val K_SCHED_COUNT           = "sched_count"
        const val K_CANCEL_COUNT          = "cancel_count"
    }

    private fun prefs(): android.content.SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @PluginMethod
    fun scheduleAlarm(call: PluginCall) {
        val id    = call.getInt("id")    ?: return call.reject("id required")
        val title = call.getString("title") ?: "Reminder"
        val body  = call.getString("body")  ?: ""
        val delayMs = call.getLong("delayMs") ?: return call.reject("delayMs required")

        val ctx = context
        val intent = Intent(ctx, AlarmReceiver::class.java).apply {
            putExtra("id",    id)
            putExtra("title", title)
            putExtra("body",  body)
        }
        val pi = PendingIntent.getBroadcast(
            ctx, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = System.currentTimeMillis() + delayMs

        val canExact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.canScheduleExactAlarms()
        } else true

        var usedExact = false
        var schedError: String? = null
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && canExact) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
                usedExact = true
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                // Permission denied on Android 12+ — fall back to inexact
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
                usedExact = false
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi)
                usedExact = true
            }
        } catch (e: SecurityException) {
            schedError = "SecurityException: ${e.message}"
            try {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
                usedExact = false
            } catch (e2: Exception) {
                schedError = "${schedError} | fallback failed: ${e2.message}"
            }
        } catch (e: Exception) {
            schedError = "${e.javaClass.simpleName}: ${e.message}"
        }

        Log.i(TAG, "scheduleAlarm id=$id title='$title' delayMs=$delayMs " +
                "triggerAt=$triggerAt usedExact=$usedExact canExact=$canExact " +
                "error=${schedError ?: "none"}")

        prefs().edit()
            .putInt(K_LAST_SCHED_ID, id)
            .putLong(K_LAST_SCHED_TRIGGER_AT, triggerAt)
            .putLong(K_LAST_SCHED_AT, System.currentTimeMillis())
            .putBoolean(K_LAST_SCHED_USED_EXACT, usedExact)
            .putString(K_LAST_SCHED_ERROR, schedError ?: "")
            .putString(K_LAST_SCHED_TITLE, title)
            .putInt(K_SCHED_COUNT, prefs().getInt(K_SCHED_COUNT, 0) + 1)
            .apply()

        val result = JSObject()
            .put("id", id)
            .put("triggerAt", triggerAt)
            .put("usedExact", usedExact)
            .put("canExact", canExact)
            .put("error", schedError ?: "")
        call.resolve(result)
    }

    @PluginMethod
    fun cancelAlarm(call: PluginCall) {
        val id = call.getInt("id") ?: return call.reject("id required")
        val ctx = context
        val intent = Intent(ctx, AlarmReceiver::class.java)
        val pi = PendingIntent.getBroadcast(
            ctx, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pi)
        Log.i(TAG, "cancelAlarm id=$id")
        prefs().edit()
            .putInt(K_LAST_CANCEL_ID, id)
            .putLong(K_LAST_CANCEL_AT, System.currentTimeMillis())
            .putInt(K_CANCEL_COUNT, prefs().getInt(K_CANCEL_COUNT, 0) + 1)
            .apply()
        call.resolve()
    }

    @PluginMethod
    fun cancelAlarms(call: PluginCall) {
        val ids = call.getArray("ids") ?: return call.reject("ids required")
        val ctx = context
        val am  = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val buf = StringBuilder()
        for (i in 0 until ids.length()) {
            val id = ids.getInt(i)
            val pi = PendingIntent.getBroadcast(
                ctx, id, Intent(ctx, AlarmReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            am.cancel(pi)
            if (buf.isNotEmpty()) buf.append(",")
            buf.append(id)
        }
        Log.i(TAG, "cancelAlarms ids=[$buf]")
        prefs().edit()
            .putLong(K_LAST_CANCEL_AT, System.currentTimeMillis())
            .putInt(K_CANCEL_COUNT, prefs().getInt(K_CANCEL_COUNT, 0) + ids.length())
            .apply()
        call.resolve()
    }

    @PluginMethod
    fun canScheduleExactAlarms(call: PluginCall) {
        val can = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms()
        } else {
            true
        }
        call.resolve(JSObject().put("value", can))
    }

    /**
     * Opens the system "Alarms & reminders" Settings page (Android 12+).
     * No-op on older Android.
     */
    @PluginMethod
    fun openExactAlarmSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val intent = Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                data = android.net.Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try {
                context.startActivity(intent)
            } catch (e: Exception) {
                Log.w(TAG, "openExactAlarmSettings failed: ${e.message}")
            }
        }
        call.resolve()
    }

    /**
     * TEMP DIAG: returns the persisted scheduling/firing state so the JS
     * layer can render a visible debug panel. Includes:
     *   - last scheduleAlarm() call (id, triggerAt, usedExact, error, title, count)
     *   - last cancelAlarm() call
     *   - last AlarmReceiver.onReceive() fire (id, at, notifyError)
     *   - whether the system reports the next alarm-clock alarm via
     *     AlarmManager.getNextAlarmClock() (limited but useful)
     */
    @PluginMethod
    fun getDiagnostics(call: PluginCall) {
        val p = prefs()
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

        val nextAlarmTriggerAt: Long = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                am.nextAlarmClock?.triggerTime ?: 0L
            } else 0L
        } catch (_: Exception) { 0L }

        val canExact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.canScheduleExactAlarms()
        } else true

        val result = JSObject()
            .put("lastScheduledId",        p.getInt(K_LAST_SCHED_ID, -1))
            .put("lastScheduledTitle",     p.getString(K_LAST_SCHED_TITLE, "") ?: "")
            .put("lastScheduledTriggerAt", p.getLong(K_LAST_SCHED_TRIGGER_AT, 0L))
            .put("lastScheduledAt",        p.getLong(K_LAST_SCHED_AT, 0L))
            .put("lastScheduledUsedExact", p.getBoolean(K_LAST_SCHED_USED_EXACT, false))
            .put("lastScheduledError",     p.getString(K_LAST_SCHED_ERROR, "") ?: "")
            .put("scheduleCount",          p.getInt(K_SCHED_COUNT, 0))
            .put("lastCancelId",           p.getInt(K_LAST_CANCEL_ID, -1))
            .put("lastCancelAt",           p.getLong(K_LAST_CANCEL_AT, 0L))
            .put("cancelCount",            p.getInt(K_CANCEL_COUNT, 0))
            .put("lastReceiverFireId",     p.getInt(AlarmReceiver.K_LAST_FIRE_ID, -1))
            .put("lastReceiverFireAt",     p.getLong(AlarmReceiver.K_LAST_FIRE_AT, 0L))
            .put("lastReceiverFireTitle",  p.getString(AlarmReceiver.K_LAST_FIRE_TITLE, "") ?: "")
            .put("lastNotifyError",        p.getString(AlarmReceiver.K_LAST_NOTIFY_ERROR, "") ?: "")
            .put("receiverFireCount",      p.getInt(AlarmReceiver.K_FIRE_COUNT, 0))
            .put("notifyCount",            p.getInt(AlarmReceiver.K_NOTIFY_COUNT, 0))
            .put("notifyFailCount",        p.getInt(AlarmReceiver.K_NOTIFY_FAIL_COUNT, 0))
            .put("nextAlarmClockTriggerAt", nextAlarmTriggerAt)
            .put("canScheduleExactAlarms", canExact)
            .put("now",                    System.currentTimeMillis())
        call.resolve(result)
    }
}
