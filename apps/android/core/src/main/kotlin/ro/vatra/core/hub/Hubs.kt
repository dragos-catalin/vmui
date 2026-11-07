package ro.vatra.core.hub

import kotlinx.serialization.Serializable
import ro.vatra.core.WireJson

/** One paired hub. The token is the device's own `vmd_` credential for that hub only. */
@Serializable
data class PairedHub(
    val id: String,
    val name: String,
    val baseUrl: String,
    val token: String,
    val deviceId: String,
    val memberName: String = "",
    val addedAt: Long = 0,
    /** Vatra Cloud relay: the hub id the push handle is bound to, and the hub's per-device E2E key (base64url). */
    val relayHubId: String = "",
    val e2eKey: String = "",
) {
    val relayed: Boolean get() = e2eKey.isNotEmpty()
}

/** The phone may belong to several homes (parents' house, holiday home): one active, the rest switchable. */
@Serializable
data class HubList(val hubs: List<PairedHub> = emptyList(), val activeId: String? = null) {
    val active: PairedHub? get() = hubs.firstOrNull { it.id == activeId } ?: hubs.firstOrNull()

    /** Re-pairing the same hub (same address) replaces its old entry instead of duplicating it. */
    fun add(h: PairedHub): HubList = copy(hubs = hubs.filterNot { it.baseUrl == h.baseUrl || it.id == h.id } + h, activeId = h.id)

    fun remove(id: String): HubList {
        val rest = hubs.filterNot { it.id == id }
        return copy(hubs = rest, activeId = if (activeId == id) rest.firstOrNull()?.id else activeId)
    }

    fun select(id: String): HubList = if (hubs.any { it.id == id }) copy(activeId = id) else this

    /** A new relay registration rotates the key; an empty key means the hub is back on direct push. */
    fun withRelayKey(id: String, relayHubId: String, e2eKey: String): HubList =
        copy(hubs = hubs.map { if (it.id == id) it.copy(relayHubId = relayHubId, e2eKey = e2eKey) else it })

    /** Hubs to try a relay push with, the active one first (the push itself does not name the hub). */
    fun relayCandidates(): List<PairedHub> = listOfNotNull(active?.takeIf { it.relayed }) + hubs.filter { it.relayed && it.id != active?.id }

    fun encode(): String = WireJson.encodeToString(serializer(), this)

    companion object {
        fun decode(s: String?): HubList = s?.let { runCatching { WireJson.decodeFromString(serializer(), it) }.getOrNull() } ?: HubList()
    }
}
