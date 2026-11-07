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
)

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

    fun encode(): String = WireJson.encodeToString(serializer(), this)

    companion object {
        fun decode(s: String?): HubList = s?.let { runCatching { WireJson.decodeFromString(serializer(), it) }.getOrNull() } ?: HubList()
    }
}
