package ro.dragoscatalin.vmui

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONArray
import org.json.JSONObject

/**
 * FCM data-only messages from the Pi (lib/notify/fcm.ts). `type=card` renders
 * the notification and acks delivery (which cancels the HA Companion fallback);
 * `type=dismiss` removes it (same tag-or-id key as show). The webview never needs to be alive for this.
 */
class PushService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    Vmui.registerPush(applicationContext, token)
  }

  override fun onMessageReceived(msg: RemoteMessage) {
    val d = msg.data
    val id = d["id"] ?: return
    when (d["type"]) {
      "dismiss" -> Notifier.cancel(applicationContext, id, d["tag"])
      else -> {
        val card = JSONObject()
        for ((k, v) in d) card.put(k, v)
        Notifier.show(applicationContext, card)
        Vmui.post(applicationContext, "/api/notify", JSONObject().put("op", "ack").put("ids", JSONArray().put(id)))
      }
    }
  }
}
