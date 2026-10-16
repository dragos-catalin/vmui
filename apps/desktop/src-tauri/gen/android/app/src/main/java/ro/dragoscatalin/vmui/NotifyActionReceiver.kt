package ro.dragoscatalin.vmui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import org.json.JSONObject

/** Buttons and swipes on a vmui notification. Calls the Pi, then updates the card. */
class NotifyActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_ACT = "ro.dragoscatalin.vmui.NOTIFY_ACT"
    const val ACTION_OPEN = "ro.dragoscatalin.vmui.NOTIFY_OPEN"
    const val ACTION_DISMISS = "ro.dragoscatalin.vmui.NOTIFY_DISMISS"
  }

  override fun onReceive(ctx: Context, intent: Intent) {
    val id = intent.getStringExtra("id") ?: return
    when (intent.action) {
      ACTION_ACT -> {
        val action = intent.getStringExtra("action") ?: return
        val pending = goAsync()
        Vmui.post(ctx, "/api/notify/act", JSONObject().put("id", id).put("action", action)) { ok, res ->
          val msg = res?.optString("message")?.takeIf { it.isNotEmpty() } ?: if (ok) "gata" else (res?.optString("error") ?: "nu a mers")
          android.os.Handler(ctx.mainLooper).post { Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show() }
          if (ok) Notifier.cancel(ctx, id, intent.getStringExtra("tag"))
          pending.finish()
        }
      }
      ACTION_OPEN -> {
        val url = intent.getStringExtra("url") ?: return
        // mark read so the centre agrees with the phone; the card stays until the source clears it
        Vmui.post(ctx, "/api/notify", JSONObject().put("op", "read").put("ids", org.json.JSONArray().put(id)))
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        try {
          ctx.startActivity(open)
        } catch (_: Exception) {
          // codai not installed: fall back to our own centre
          ctx.startActivity(Intent(ctx, MainActivity::class.java).apply { action = Intent.ACTION_VIEW; data = Uri.parse("vmui://notifications/$id"); addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
        }
        // collapse the shade
        @Suppress("DEPRECATION")
        ctx.sendBroadcast(Intent(Intent.ACTION_CLOSE_SYSTEM_DIALOGS))
      }
      ACTION_DISMISS -> Vmui.post(ctx, "/api/notify", JSONObject().put("op", "dismiss").put("id", id))
    }
  }
}
