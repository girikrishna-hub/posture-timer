package com.sitstand.timer

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AlarmManager")
class AlarmManagerPlugin : Plugin() {

    @PluginMethod
    fun scheduleAlarm(call: PluginCall) {
        val id      = call.getInt("id")         ?: return call.reject("id required")
        val title   = call.getString("title")   ?: "Reminder"
        val body    = call.getString("body")    ?: ""
        val delayMs = call.getLong("delayMs")   ?: return call.reject("delayMs required")

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

        try {
            // setExactAndAllowWhileIdle fires through Doze mode but requires
            // SCHEDULE_EXACT_ALARM to be granted by the user (Android 12+).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            }
        } catch (se: SecurityException) {
            // SCHEDULE_EXACT_ALARM not yet granted by the user.
            // Fall back to inexact — still fires, just with up to 10 min drift.
            // The JS side detects this via canScheduleExactAlarms() and shows
            // a prompt in the Settings page so the user can grant the permission.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
        }
        call.resolve()
    }

    @PluginMethod
    fun openExactAlarmSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Opens Settings → Apps → Special access → Alarms & reminders
            // scoped to this app so the user can toggle the permission on.
            val intent = Intent(
                Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                android.net.Uri.parse("package:${context.packageName}")
            ).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
            try {
                context.startActivity(intent)
            } catch (_: Exception) {
                // Some OEMs don't support the scoped action — fall back to the
                // generic app details screen where the user can still find it.
                context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:${context.packageName}")
                    ).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
                )
            }
        }
        call.resolve()
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
        call.resolve()
    }

    @PluginMethod
    fun cancelAlarms(call: PluginCall) {
        val ids = call.getArray("ids") ?: return call.reject("ids required")
        val ctx = context
        val am  = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        for (i in 0 until ids.length()) {
            val id = ids.getInt(i)
            val pi = PendingIntent.getBroadcast(
                ctx, id, Intent(ctx, AlarmReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            am.cancel(pi)
        }
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
}
