package ro.dragoscatalin.vmui

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Renders a vmui card as a native notification: colour + tinted icon per kind,
 * big picture when the card has an image, a progress bar for water/agents,
 * up to 3 action buttons that call back /api/notify/act, and a tap that opens
 * the card's deep link (codai://session/…) or the app's notification centre.
 * The card JSON is the same shape FCM delivers and SSE streams.
 */
object Notifier {
  private const val GROUP = "vmui"

  private fun channelId(kind: String, priority: String): String = when {
    priority == "urgent" -> "vmui_urgent"
    kind == "copilot" || kind == "agents" -> if (priority == "low") "vmui_quiet" else "vmui_copilot"
    priority == "low" -> "vmui_quiet"
    else -> "vmui_default"
  }

  fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = ctx.getSystemService(NotificationManager::class.java)
    fun ch(id: String, name: String, imp: Int, vibrate: Boolean) {
      if (nm.getNotificationChannel(id) != null) return
      nm.createNotificationChannel(NotificationChannel(id, name, imp).apply {
        enableVibration(vibrate); setShowBadge(imp >= NotificationManager.IMPORTANCE_DEFAULT)
      })
    }
    ch("vmui_urgent", "Urgent · interfon, prezență", NotificationManager.IMPORTANCE_HIGH, true)
    ch("vmui_copilot", "Copilot", NotificationManager.IMPORTANCE_HIGH, true)
    ch("vmui_default", "Casă", NotificationManager.IMPORTANCE_DEFAULT, false)
    ch("vmui_quiet", "Discret · agenți, apă, baterii", NotificationManager.IMPORTANCE_LOW, false)
  }

  private fun notifId(id: String): Int = id.hashCode() and 0x7fffffff

  /** Builds and posts; network (image) happens on the caller's thread — call from a worker. */
  fun show(ctx: Context, card: JSONObject) {
    ensureChannels(ctx)
    val id = card.optString("id")
    if (id.isEmpty()) return
    val kind = card.optString("kind", "system")
    val priority = card.optString("priority", "default")
    val color = parseColor(card.optString("color"), kind)
    val title = card.optString("title")
    val body = card.optString("body")
    val subtitle = card.optString("subtitle")
    val image = card.optString("image")
    val url = card.optString("url")
    val progress = card.optString("progress").toIntOrNull()
    val sticky = card.optString("sticky") == "1" || card.optBoolean("sticky", false)

    val tap = if (url.isNotEmpty()) openUrl(ctx, url, id) else openApp(ctx, id)
    val b = NotificationCompat.Builder(ctx, channelId(kind, priority))
      .setSmallIcon(R.drawable.ic_notif)
      .setLargeIcon(kindIcon(ctx, kind, color))
      .setColor(color)
      .setColorized(priority == "urgent")
      .setContentTitle(title)
      .setContentText(body.ifEmpty { subtitle })
      .setSubText(subtitle.takeIf { it.isNotEmpty() && body.isNotEmpty() })
      .setContentIntent(tap)
      .setAutoCancel(!sticky)
      .setOngoing(sticky && priority != "low")
      .setOnlyAlertOnce(true)
      .setGroup(GROUP)
      .setCategory(when (kind) { "intercom" -> NotificationCompat.CATEGORY_CALL; "copilot" -> NotificationCompat.CATEGORY_MESSAGE; "presence", "door" -> NotificationCompat.CATEGORY_ALARM; else -> NotificationCompat.CATEGORY_STATUS })
      .setPriority(when (priority) { "urgent", "high" -> NotificationCompat.PRIORITY_HIGH; "low" -> NotificationCompat.PRIORITY_LOW; else -> NotificationCompat.PRIORITY_DEFAULT })
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setWhen(card.optString("at").toLongOrNull() ?: System.currentTimeMillis())
      .setShowWhen(true)
      .setDeleteIntent(dismissIntent(ctx, id))

    if (progress != null) b.setProgress(100, progress.coerceIn(0, 100), false)

    val bmp = if (image.isNotEmpty()) fetchBitmap(image) else null
    if (bmp != null) {
      b.setStyle(NotificationCompat.BigPictureStyle().bigPicture(bmp).bigLargeIcon(null as Bitmap?).setSummaryText(body))
    } else if (body.contains('\n') || body.length > 60) {
      b.setStyle(NotificationCompat.BigTextStyle().bigText(body).setSummaryText(subtitle))
    }

    val actions = try { JSONArray(card.optString("actions", "[]")) } catch (_: Exception) { JSONArray() }
    for (i in 0 until minOf(3, actions.length())) {
      val a = actions.optJSONObject(i) ?: continue
      val aid = a.optString("id"); val label = a.optString("label")
      if (aid.isEmpty() || label.isEmpty()) continue
      val aUrl = a.optString("url")
      val pi = if (aUrl.isNotEmpty()) openUrl(ctx, aUrl, id, aid) else actIntent(ctx, id, aid)
      b.addAction(NotificationCompat.Action.Builder(null as IconCompat?, label, pi).build())
    }
    if (priority == "urgent") b.setFullScreenIntent(tap, true)

    try { NotificationManagerCompat.from(ctx).notify(notifId(id), b.build()) } catch (_: SecurityException) { /* POST_NOTIFICATIONS denied */ }
  }

  fun cancel(ctx: Context, id: String) {
    NotificationManagerCompat.from(ctx).cancel(notifId(id))
  }

  private fun openApp(ctx: Context, id: String): PendingIntent {
    val i = Intent(ctx, MainActivity::class.java).apply {
      action = Intent.ACTION_VIEW
      data = Uri.parse("vmui://notifications/$id")
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    return PendingIntent.getActivity(ctx, notifId("open-$id"), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** Deep link (codai://…, https://…) through the action receiver so the card is marked read/dismissed first. */
  private fun openUrl(ctx: Context, url: String, id: String, actionId: String = "open"): PendingIntent {
    val i = Intent(ctx, NotifyActionReceiver::class.java).apply {
      action = NotifyActionReceiver.ACTION_OPEN
      putExtra("id", id); putExtra("action", actionId); putExtra("url", url)
    }
    return PendingIntent.getBroadcast(ctx, notifId("url-$id-$actionId"), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun actIntent(ctx: Context, id: String, actionId: String): PendingIntent {
    val i = Intent(ctx, NotifyActionReceiver::class.java).apply {
      action = NotifyActionReceiver.ACTION_ACT
      putExtra("id", id); putExtra("action", actionId)
    }
    return PendingIntent.getBroadcast(ctx, notifId("act-$id-$actionId"), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun dismissIntent(ctx: Context, id: String): PendingIntent {
    val i = Intent(ctx, NotifyActionReceiver::class.java).apply { action = NotifyActionReceiver.ACTION_DISMISS; putExtra("id", id) }
    return PendingIntent.getBroadcast(ctx, notifId("dis-$id"), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun parseColor(hex: String, kind: String): Int {
    if (hex.matches(Regex("^#[0-9a-fA-F]{6}$"))) return Color.parseColor(hex)
    return when (kind) {
      "copilot", "agents" -> 0xff6366f1.toInt(); "intercom" -> 0xffff5a1f.toInt(); "pairing" -> 0xff22c55e.toInt()
      "water", "window" -> 0xff8fd3ff.toInt(); "pc" -> 0xff7cff9a.toInt(); "pi", "door" -> 0xfff2b85a.toInt()
      "presence" -> 0xffc084fc.toInt(); "battery" -> 0xffff7a7a.toInt(); "contact" -> 0xff38bdf8.toInt(); else -> 0xff94a3b8.toInt()
    }
  }

  private fun kindDrawable(kind: String): Int = when (kind) {
    "copilot", "agents" -> R.drawable.ic_k_bot; "intercom" -> R.drawable.ic_k_bell
    "pairing" -> R.drawable.ic_k_phone; "water" -> R.drawable.ic_sc_water
    "pc" -> R.drawable.ic_sc_pc; "pi" -> R.drawable.ic_k_cpu
    "door" -> R.drawable.ic_k_door; "window" -> R.drawable.ic_k_window
    "presence" -> R.drawable.ic_k_radar; "battery" -> R.drawable.ic_k_battery
    "contact" -> R.drawable.ic_k_mail
    else -> R.drawable.ic_notif
  }

  /** Round tinted disc with the kind's glyph — the "large icon" slot. */
  private fun kindIcon(ctx: Context, kind: String, color: Int): Bitmap {
    val size = (48 * ctx.resources.displayMetrics.density).toInt()
    val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
    c.drawCircle(size / 2f, size / 2f, size / 2f, p)
    val d = ctx.getDrawable(kindDrawable(kind)) ?: return bmp
    val inset = size / 4
    d.setBounds(inset, inset, size - inset, size - inset)
    d.colorFilter = PorterDuffColorFilter(0xff0b0f1a.toInt(), PorterDuff.Mode.SRC_IN)
    d.draw(c)
    return bmp
  }

  private fun fetchBitmap(url: String): Bitmap? = try {
    val con = (URL(url).openConnection() as HttpURLConnection).apply { connectTimeout = 5000; readTimeout = 8000 }
    con.inputStream.use { BitmapFactory.decodeStream(it) }
  } catch (_: Exception) { null }
}
