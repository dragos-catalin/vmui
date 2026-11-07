package ro.vatra.core.home

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import ro.vatra.core.model.Device
import ro.vatra.core.model.EntityState
import ro.vatra.core.model.HomeState

/** What a tile shows for one device, derived from the hub state once for phone, watch, TV and widgets. */
data class DeviceTile(
    val id: String,
    val name: String,
    val kind: String,
    val room: String,
    val entity: String?,
    val on: Boolean?,
    val available: Boolean,
    val brightnessPct: Int?,
    val canControl: Boolean,
) {
    /** A tap toggles only things that have an on/off and that this member controls. */
    val toggleable: Boolean get() = canControl && available && on != null && entity != null
}

data class RoomView(val id: String, val name: String, val canControl: Boolean, val devices: List<DeviceTile>) {
    val onCount: Int get() = devices.count { it.on == true }
}

object HomeView {
    private val TOGGLE_DOMAINS = setOf("light", "switch", "fan", "media_player", "climate", "humidifier", "input_boolean")

    fun rooms(s: HomeState): List<RoomView> {
        val byRoom = s.devices.groupBy { it.room }
        return s.rooms.map { r -> RoomView(r.id, r.name, r.canControl, byRoom[r.id].orEmpty().map { tile(it, s.states, r.canControl) }) }
    }

    fun tile(d: Device, states: Map<String, EntityState>, canControl: Boolean): DeviceTile {
        val st = d.entity?.let(states::get)
        val domain = d.entity?.substringBefore('.')
        val on = when {
            st == null || domain !in TOGGLE_DOMAINS -> null
            st.state == "unavailable" || st.state == "unknown" -> null
            domain == "climate" -> st.state != "off"
            domain == "media_player" -> st.state !in setOf("off", "standby")
            else -> st.state == "on"
        }
        val bri = (st?.attributes?.get("brightness") as? JsonPrimitive)?.intOrNull?.let { (it * 100 + 127) / 255 }
        return DeviceTile(d.id, d.name, d.kind, d.room, d.entity, on, st != null && st.state != "unavailable", bri, canControl)
    }

    /** House-wide summary line data for the watch tile / widget: lights on, rooms total. */
    fun lightsOn(s: HomeState): Int = rooms(s).sumOf { r -> r.devices.count { it.kind == "light" && it.on == true } }
}
