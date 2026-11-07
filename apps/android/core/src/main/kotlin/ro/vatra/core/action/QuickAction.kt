package ro.vatra.core.action

import ro.vatra.core.model.Control
import ro.vatra.core.model.IntercomAct
import ro.vatra.core.model.LightsOp
import ro.vatra.core.model.WaterAct
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient
import ro.vatra.core.net.map
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * One tap-able house action shared by NFC tags, the QS tile, widgets, the watch and Device Controls.
 * Encoded as `vatra://do?a=<kind>&…` so an NFC tag carries nothing secret: whoever taps it still acts
 * through their own paired device and room permissions.
 */
sealed interface QuickAction {
    data class Scene(val id: String) : QuickAction
    data class Toggle(val entity: String, val on: Boolean) : QuickAction
    data class Script(val name: String) : QuickAction
    data class Ambilight(val mode: String) : QuickAction
    data object Water : QuickAction
    data object DoorIgnore : QuickAction

    fun toUri(): String = when (this) {
        is Scene -> "vatra://do?a=scene&id=${enc(id)}"
        is Toggle -> "vatra://do?a=toggle&e=${enc(entity)}&on=${if (on) 1 else 0}"
        is Script -> "vatra://do?a=script&n=${enc(name)}"
        is Ambilight -> "vatra://do?a=ambilight&m=${enc(mode)}"
        Water -> "vatra://do?a=water"
        DoorIgnore -> "vatra://do?a=door-ignore"
    }

    suspend fun run(c: HubClient): ApiResult<Unit> = when (this) {
        is Scene -> c.lights(LightsOp.ApplyScene(id)).map { }
        is Toggle -> c.control(Control.Toggle(entity, on)).map { }
        is Script -> c.control(Control.Script(name)).map { }
        is Ambilight -> c.control(Control.Ambilight(mode)).map { }
        Water -> c.water(WaterAct()).map { }
        DoorIgnore -> c.intercom(IntercomAct("ignore")).map { }
    }

    companion object {
        private val ENTITY = Regex("^[a-z_]+\\.[a-z0-9_]+$")
        private val SCRIPTS = setOf("pc_wake", "movie_mode_on", "movie_mode_off", "music_mode")
        private val MODES = setOf("movie", "music", "off")

        private fun enc(s: String) = URLEncoder.encode(s, Charsets.UTF_8)

        /** Same allow-lists as the hub's zod schemas: a tag can never smuggle in anything else. */
        fun parse(raw: String): QuickAction? {
            val u = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
            if (!u.scheme.equals("vatra", true) || !u.host.equals("do", true)) return null
            val q = u.rawQuery.orEmpty().split('&').mapNotNull {
                val i = it.indexOf('=')
                if (i <= 0) null else it.substring(0, i) to URLDecoder.decode(it.substring(i + 1), Charsets.UTF_8)
            }.toMap()
            return when (q["a"]) {
                "scene" -> q["id"]?.takeIf { it.isNotBlank() && it.length <= 120 }?.let(::Scene)
                "toggle" -> q["e"]?.takeIf(ENTITY::matches)?.let { Toggle(it, q["on"] == "1") }
                "script" -> q["n"]?.takeIf { it in SCRIPTS }?.let(::Script)
                "ambilight" -> q["m"]?.takeIf { it in MODES }?.let(::Ambilight)
                "water" -> Water
                "door-ignore" -> DoorIgnore
                else -> null
            }
        }
    }
}
