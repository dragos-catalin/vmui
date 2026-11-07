package ro.vatra.core.push

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import ro.vatra.core.WireJson
import ro.vatra.core.model.CardAction

/**
 * One wake-up from the hub, whichever way it came: the FCM data map (src/lib/notify/fcm.ts) or the
 * decrypted UnifiedPush JSON (src/lib/notify/unifiedpush.ts). Both carry the same string fields.
 */
data class PushPayload(
    val type: String,
    val id: String,
    val kind: String,
    val tag: String,
    val title: String,
    val body: String,
    val subtitle: String,
    val color: String,
    val priority: String,
    val progress: Int?,
    val actions: List<CardAction>,
    val url: String,
    val sticky: Boolean,
    val at: Long,
    /** The payload was trimmed to fit Web Push: fetch the full card from /api/v1/app/notify. */
    val needsFetch: Boolean,
) {
    val isDismiss: Boolean get() = type == "dismiss"
    val isIntercomRing: Boolean get() = kind == "intercom" && !isDismiss && (priority == "high" || priority == "urgent")

    /** A stable Android notification id per card (tag wins, so a re-sent card replaces itself). */
    val notificationId: Int get() = (tag.ifEmpty { id }).hashCode()

    companion object {
        fun fromMap(m: Map<String, String>): PushPayload? {
            val id = m["id"]?.takeIf { it.isNotEmpty() } ?: return null
            val actions = m["actions"]?.takeIf { it.isNotEmpty() }?.let {
                runCatching { WireJson.decodeFromString(ListSerializer(CardAction.serializer()), it) }.getOrNull()
            }.orEmpty()
            return PushPayload(
                type = m["type"] ?: "card",
                id = id,
                kind = m["kind"].orEmpty(),
                tag = m["tag"].orEmpty(),
                title = m["title"].orEmpty(),
                body = m["body"].orEmpty(),
                subtitle = m["subtitle"].orEmpty(),
                color = m["color"].orEmpty(),
                priority = m["priority"] ?: "default",
                progress = m["progress"]?.toIntOrNull(),
                actions = actions,
                url = m["url"].orEmpty(),
                sticky = m["sticky"] == "1",
                at = m["at"]?.toLongOrNull() ?: 0L,
                needsFetch = m["fetch"] == "1",
            )
        }

        /** UnifiedPush delivers the JSON object as bytes. */
        fun fromJson(bytes: ByteArray): PushPayload? {
            val obj = runCatching { WireJson.parseToJsonElement(bytes.decodeToString()) as? JsonObject }.getOrNull() ?: return null
            return fromMap(obj.mapValues { (_, v) -> (v as? JsonPrimitive)?.contentOrNull.orEmpty() })
        }
    }
}
