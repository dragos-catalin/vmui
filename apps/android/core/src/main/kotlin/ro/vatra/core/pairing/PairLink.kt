package ro.vatra.core.pairing

import java.net.URI
import java.net.URLDecoder

/** `vatra://pair?h=<hub url>&c=<one-time invite>` as shown by POST /api/devices/pair/invite. */
data class PairLink(val hub: String, val invite: String) {
    companion object {
        private val INVITE = Regex("^[A-Za-z0-9_-]{16,64}$")

        /** Null for anything that is not a well-formed Vatra invite (a stray QR, a URL with a script, …). */
        fun parse(raw: String): PairLink? {
            val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
            if (!uri.scheme.equals("vatra", ignoreCase = true) || !uri.host.equals("pair", ignoreCase = true)) return null
            val q = (uri.rawQuery ?: return null).split('&').mapNotNull {
                val i = it.indexOf('=')
                if (i <= 0) null else it.substring(0, i) to URLDecoder.decode(it.substring(i + 1), Charsets.UTF_8)
            }.toMap()
            val hub = normaliseHub(q["h"] ?: return null) ?: return null
            val code = q["c"]?.takeIf { INVITE.matches(it) } ?: return null
            return PairLink(hub, code)
        }

        /** Only http(s) origins: no path, no credentials, no query (a QR must not point the token elsewhere). */
        fun normaliseHub(raw: String): String? {
            val withScheme = if ("://" in raw) raw.trim() else "http://${raw.trim()}"
            val u = runCatching { URI(withScheme) }.getOrNull() ?: return null
            val scheme = u.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = u.host ?: return null
            if (u.rawUserInfo != null || !u.rawQuery.isNullOrEmpty() || !u.rawFragment.isNullOrEmpty()) return null
            if (!(u.rawPath.isNullOrEmpty() || u.rawPath == "/")) return null
            val h = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            return "$scheme://$h${if (u.port > 0) ":${u.port}" else ""}"
        }
    }
}
