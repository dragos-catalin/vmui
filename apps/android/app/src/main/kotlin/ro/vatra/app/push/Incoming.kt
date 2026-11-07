package ro.vatra.app.push

import android.content.Context
import android.util.Log
import ro.vatra.app.VatraApp
import ro.vatra.core.model.Card
import ro.vatra.core.model.NotifyOp
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient
import ro.vatra.core.push.PushCrypto
import ro.vatra.core.push.PushPayload

/** Common landing for both transports: draw it, ack delivery (stops the hub's HA fallback), fetch when trimmed. */
object Incoming {
    suspend fun handle(c: Context, p: PushPayload, via: HubClient? = null) {
        val app = VatraApp.from(c)
        val client = via ?: app.activeClient()
        val full = if (p.needsFetch && client != null) {
            fetch(client, p.id)?.let { card -> p.copy(title = card.title, body = card.body, subtitle = card.subtitle.orEmpty(), actions = card.actions, needsFetch = false) } ?: p
        } else {
            p
        }
        Notifier.show(c, full)
        if (!p.isDismiss) client?.notify(NotifyOp.Ack(listOf(p.id)))
    }

    /** One card by id; hubs older than the relay endpoint only have the notify list. */
    private suspend fun fetch(client: HubClient, id: String): Card? =
        when (val r = client.pushCard(id)) {
            is ApiResult.Ok -> r.value
            else -> (client.cards() as? ApiResult.Ok)?.value?.cards?.firstOrNull { it.id == id }
        }

    /**
     * A Vatra Cloud relay push (`e` present). It does not name the hub, so every relayed hub's key is
     * tried, the active one first; the GCM tag picks the right one. Nothing that opens → a generic
     * notification, so an alert is never silently lost (and never a crash in the FCM service).
     */
    suspend fun handleRelay(c: Context, data: Map<String, String>) {
        val app = VatraApp.from(c)
        val opened = runCatching {
            app.hubs.current().relayCandidates().firstNotNullOfOrNull { hub ->
                val key = runCatching { PushCrypto.decodeKey(hub.e2eKey) }.getOrNull() ?: return@firstNotNullOfOrNull null
                PushPayload.fromRelay(data, key)?.let { it to hub }
            }
        }.getOrNull()
        if (opened == null) {
            Log.w(TAG, "relay push did not open with any hub key")
            if (data["type"] != "dismiss") Notifier.showGeneric(c, data["id"].orEmpty())
            return
        }
        val (p, hub) = opened
        runCatching { handle(c, p, app.client(hub)) }.onFailure { Log.w(TAG, "relay push handling failed", it) }
    }

    private const val TAG = "VatraPush"
}
