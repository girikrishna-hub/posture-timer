package com.sitstand.timer

import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.*
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Full-screen alarm activity that appears above the lock screen.
 *
 * Triggered by AlarmReceiver via a fullScreenIntent notification.
 * Turns the screen on, keeps it awake, and shows Dismiss / Snooze buttons.
 */
class AlarmFullScreenActivity : AppCompatActivity() {

    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator?       = null

    private val notificationId get() = intent.getIntExtra("id", 0)

    // ── Lifecycle ───────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Show above lock screen and turn the screen on
        enableOverLockScreen()

        val title = intent.getStringExtra("title") ?: "Posture Reminder"
        val body  = intent.getStringExtra("body")  ?: "Time to change position."

        setContentView(buildLayout(title, body))

        val silent = intent.getBooleanExtra("silent", false)
        if (!silent) startAlarmSound()
        startVibration()   // vibration fires even in silent mode (matches channel behaviour)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    override fun onDestroy() {
        stopAlarm()
        super.onDestroy()
    }

    // ── Lock-screen flags ───────────────────────────────────────────────────

    private fun enableOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val km = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
            km.requestDismissKeyguard(this, null)
        }
        // Also set window flags for older APIs and as a belt-and-suspenders on newer ones
        @Suppress("DEPRECATION")
        window.addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED         or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON           or
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON           or
            WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
        )
    }

    // ── UI ──────────────────────────────────────────────────────────────────

    private fun buildLayout(title: String, body: String): LinearLayout {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity     = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0d1f12"))
            setPadding(dp(32), dp(64), dp(32), dp(64))
        }

        // Icon area (simple coloured circle placeholder)
        val icon = TextView(this).apply {
            text      = "⏰"
            textSize  = 56f
            gravity   = Gravity.CENTER
        }
        root.addView(icon, lp(wrap = true).also { it.bottomMargin = dp(24) })

        // Title
        root.addView(TextView(this).apply {
            text      = title
            textSize  = 28f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity   = Gravity.CENTER
        }, lp(wrap = true).also { it.bottomMargin = dp(12) })

        // Body
        root.addView(TextView(this).apply {
            text      = body
            textSize  = 17f
            setTextColor(Color.parseColor("#a5d6a7"))
            gravity   = Gravity.CENTER
        }, lp(wrap = true).also { it.bottomMargin = dp(48) })

        // Dismiss button
        root.addView(buildButton("Dismiss", Color.parseColor("#2e7d32")) {
            dismiss()
        }, lp(wrap = false).also { it.bottomMargin = dp(16) })

        // Snooze button
        root.addView(buildButton("Snooze 5 min", Color.parseColor("#1b5e20")) {
            snooze()
        }, lp(wrap = false))

        return root
    }

    private fun buildButton(label: String, bgColor: Int, action: () -> Unit): Button =
        Button(this).apply {
            text    = label
            textSize = 17f
            setTextColor(Color.WHITE)
            setBackgroundColor(bgColor)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            setOnClickListener { action() }
        }

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    private fun lp(wrap: Boolean = true): LinearLayout.LayoutParams =
        if (wrap) LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
        else LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )

    // ── Actions ─────────────────────────────────────────────────────────────

    private fun dismiss() {
        stopAlarm()
        cancelNotification()
        finish()
    }

    private fun snooze() {
        stopAlarm()
        cancelNotification()

        // Reschedule the same alarm 5 minutes from now via AlarmManager.
        // Use alarm_id (original scheduling id) + 500 as the snooze alarm id
        // so it doesn't collide with any currently-scheduled alarm.
        val snoozedTitle = intent.getStringExtra("title") ?: "Posture Reminder"
        val snoozedBody  = intent.getStringExtra("body")  ?: ""
        val originalId   = intent.getIntExtra("alarm_id", notificationId)
        val snoozeId     = originalId + 500

        val alarmIntent = Intent(this, AlarmReceiver::class.java).apply {
            putExtra("id",    snoozeId)
            putExtra("title", "⏱ Snoozed: $snoozedTitle")
            putExtra("body",  snoozedBody)
        }
        val pi = PendingIntent.getBroadcast(
            this, snoozeId, alarmIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = System.currentTimeMillis() + 5 * 60 * 1000L
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi)
        }

        finish()
    }

    // ── Audio ───────────────────────────────────────────────────────────────

    private fun startAlarmSound() {
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(this@AlarmFullScreenActivity, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (_: Exception) { /* silent — no audio is better than a crash */ }
    }

    // ── Vibration ───────────────────────────────────────────────────────────

    private fun startVibration() {
        try {
            vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(VIBRATOR_SERVICE) as Vibrator
            }

            val pattern = longArrayOf(0, 600, 200, 600, 200, 600)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(pattern, 0)
            }
        } catch (_: Exception) {}
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────

    private fun stopAlarm() {
        mediaPlayer?.runCatching {
            if (isPlaying) stop()
            release()
        }
        mediaPlayer = null
        vibrator?.cancel()
    }

    private fun cancelNotification() {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(notificationId)
    }
}
