package ro.vatra.app.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.content.ContextCompat
import ro.vatra.app.MainActivity
import ro.vatra.app.R
import ro.vatra.core.push.PushPayload

/**
 * Draws the hub's cards as native notifications. Data-only pushes (FCM and UnifiedPush alike), so the
 * app owns the look: channel per importance, the card's action buttons, and the door intercom as a
 * CallStyle notification (full-screen on a locked phone, Answer = open the door, Decline = ignore).
 */
object Notifier {
    const val CH_INTERCOM = "intercom"
    const val CH_HIGH = "alerts"
    const val CH_DEFAULT = "house"
    const val CH_LOW = "quiet"

    fun createChannels(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        val ring = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CH_INTERCOM, c.getString(R.string.ch_intercom), NotificationManager.IMPORTANCE_HIGH).apply {
                    setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ring)
                    enableVibration(true)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
                NotificationChannel(CH_HIGH, c.getString(R.string.ch_alerts), NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(CH_DEFAULT, c.getString(R.string.ch_house), NotificationManager.IMPORTANCE_DEFAULT),
                NotificationChannel(CH_LOW, c.getString(R.string.ch_quiet), NotificationManager.IMPORTANCE_LOW),
            ),
        )
    }

    fun channelFor(p: PushPayload): String = when {
        p.isIntercomRing -> CH_INTERCOM
        p.priority == "urgent" || p.priority == "high" -> CH_HIGH
        p.priority == "low" -> CH_LOW
        else -> CH_DEFAULT
    }

    fun show(c: Context, p: PushPayload) {
        val nm = c.getSystemService(NotificationManager::class.java)
        if (p.isDismiss) {
            nm.cancel(p.notificationId)
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = PendingIntent.getActivity(c, p.notificationId, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = Notification.Builder(c, channelFor(p))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(p.title)
            .setContentText(p.body.ifEmpty { null })
            .setSubText(p.subtitle.ifEmpty { null })
            .setContentIntent(open)
            .setAutoCancel(!p.sticky)
            .setOngoing(p.sticky)
            .setWhen(if (p.at > 0) p.at else System.currentTimeMillis())
        parseColor(p.color)?.let { b.setColor(it) }
        p.progress?.let { b.setProgress(100, it, false) }

        if (p.isIntercomRing) {
            val canOpen = p.actions.any { it.id == "open" }
            val caller = Person.Builder().setName(p.title).setImportant(true).build()
            val decline = actionIntent(c, p, "ignore")
            b.setCategory(Notification.CATEGORY_CALL)
                .setFullScreenIntent(open, true)
                .setStyle(
                    if (canOpen) Notification.CallStyle.forIncomingCall(caller, decline, actionIntent(c, p, "open"))
                    else Notification.CallStyle.forScreeningCall(caller, decline, open),
                )
        } else {
            p.actions.take(3).forEach { a ->
                b.addAction(Notification.Action.Builder(null, a.label, actionIntent(c, p, a.id)).build())
            }
        }
        nm.notify(p.notificationId, b.build())
    }

    private fun actionIntent(c: Context, p: PushPayload, action: String): PendingIntent =
        PendingIntent.getBroadcast(
            c,
            (p.id + action).hashCode(),
            Intent(c, ActionReceiver::class.java).putExtra(ActionReceiver.EXTRA_CARD, p.id).putExtra(ActionReceiver.EXTRA_ACTION, action).putExtra(ActionReceiver.EXTRA_NID, p.notificationId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private fun parseColor(s: String): Int? = runCatching { if (s.startsWith("#")) Color.parseColor(s) else null }.getOrNull()
}
