package ro.vatra.app.push

import android.content.Context
import ro.vatra.app.VatraApp
import ro.vatra.core.model.NotifyOp
import ro.vatra.core.push.PushPayload

/** Common landing for both transports: draw it, ack delivery (stops the hub's HA fallback), fetch when trimmed. */
object Incoming {
    suspend fun handle(c: Context, p: PushPayload) {
        val app = VatraApp.from(c)
        val client = app.activeClient()
        val full = if (p.needsFetch && client != null) {
            client.cards().let { r -> (r as? ro.vatra.core.net.ApiResult.Ok)?.value?.cards?.firstOrNull { it.id == p.id } }
                ?.let { card -> p.copy(title = card.title, body = card.body, subtitle = card.subtitle.orEmpty(), actions = card.actions, needsFetch = false) } ?: p
        } else {
            p
        }
        Notifier.show(c, full)
        if (!p.isDismiss) client?.notify(NotifyOp.Ack(listOf(p.id)))
    }
}
