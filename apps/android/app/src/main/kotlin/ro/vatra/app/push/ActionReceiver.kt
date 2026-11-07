package ro.vatra.app.push

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.launch
import ro.vatra.app.VatraApp
import ro.vatra.core.model.NotifyOp
import ro.vatra.core.net.ApiResult

/** A notification button: sent to the hub as this device (its member's rights decide, e.g. who may open the door). */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val card = intent.getStringExtra(EXTRA_CARD) ?: return
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val nid = intent.getIntExtra(EXTRA_NID, 0)
        val app = VatraApp.from(context)
        val pending = goAsync()
        app.scope.launch {
            try {
                val c = app.activeClient() ?: return@launch
                val r = c.act(card, action)
                if (r is ApiResult.Ok) {
                    context.getSystemService(NotificationManager::class.java).cancel(nid)
                    c.notify(NotifyOp.Read(listOf(card)))
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val EXTRA_CARD = "card"
        const val EXTRA_ACTION = "action"
        const val EXTRA_NID = "nid"
    }
}
