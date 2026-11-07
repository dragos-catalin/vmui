package ro.vatra.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Wire shapes of /api/v1/app/* (src/lib/api/app-routes.ts, snapshot docs/api/app-openapi.json).
// Decoded with ignoreUnknownKeys so an additive hub change never breaks an installed app.

@Serializable
data class Discover(
    val app: String = "",
    val product: String = "",
    val host: String = "",
    val version: String = "",
    val apiVersion: Int = 0,
    val minClient: Int = 0,
    val claimed: Boolean = true,
    val pair: String = "/api/devices/pair",
)

@Serializable
data class Member(val displayName: String, val role: String)

@Serializable
data class Can(val openDoor: Boolean, val manageHome: Boolean)

@Serializable
data class Me(
    val apiVersion: Int,
    val minClient: Int,
    val member: Member,
    val deviceId: String? = null,
    val rooms: Map<String, String> = emptyMap(),
    val can: Can,
)

@Serializable
data class Room(val id: String, val name: String, val level: String) {
    val canControl: Boolean get() = level == "control"
}

@Serializable
data class Device(
    val id: String,
    val name: String,
    val kind: String,
    val room: String,
    val entity: String? = null,
    val entities: List<String> = emptyList(),
)

@Serializable
data class EntityState(val state: String, val attributes: JsonObject = JsonObject(emptyMap()))

@Serializable
data class HomeState(
    val rooms: List<Room> = emptyList(),
    val devices: List<Device> = emptyList(),
    val states: Map<String, EntityState> = emptyMap(),
    val haOnline: Boolean = false,
)

@Serializable
data class Segment(val id: String, val name: String)

@Serializable
data class Light(
    val id: String,
    val name: String,
    val room: String,
    val health: String,
    val segments: List<Segment> = emptyList(),
    val capabilities: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class Scene(val id: String, val name: String)

@Serializable
data class Lights(val devices: List<Light> = emptyList(), val scenes: List<Scene> = emptyList())

@Serializable
data class LightState(
    val on: Boolean? = null,
    val rgb: List<Int>? = null,
    val brightnessPct: Int? = null,
    val kelvin: Int? = null,
)

/** POST /api/v1/app/lights. */
@Serializable
sealed interface LightsOp {
    @Serializable @SerialName("set")
    data class Set(val target: String, val state: LightState) : LightsOp

    @Serializable @SerialName("scene")
    data class ApplyScene(val id: String) : LightsOp

    @Serializable @SerialName("undo")
    data object Undo : LightsOp
}

@Serializable
data class Applied(val ok: Boolean, val applied: Int)

/** POST /api/v1/app/control: one device command or a house scene. */
@Serializable
sealed interface Control {
    @Serializable @SerialName("toggle")
    data class Toggle(val entity: String, val on: Boolean) : Control

    @Serializable @SerialName("light")
    data class SetLight(val entity: String, val rgb: List<Int>? = null, val brightnessPct: Int? = null, val kelvin: Int? = null) : Control

    @Serializable @SerialName("climate")
    data class Climate(val entity: String, val hvacMode: String? = null, val temperature: Double? = null, val fanMode: String? = null) : Control

    @Serializable @SerialName("select")
    data class Select(val entity: String, val option: String) : Control

    @Serializable @SerialName("media")
    data class Media(val entity: String, val command: String) : Control

    @Serializable @SerialName("ambilight")
    data class Ambilight(val mode: String) : Control

    @Serializable @SerialName("script")
    data class Script(val name: String) : Control
}

@Serializable
data class Ok(val ok: Boolean = true)

@Serializable
data class CardAct(val id: String, val action: String)

/** POST /api/v1/app/presence. */
@Serializable
data class PresenceReport(val state: String, val source: String = "geofence")

@Serializable
data class PresenceResult(val ok: Boolean, val fired: Boolean)

@Serializable
data class CardAction(val id: String, val label: String, val style: String, val url: String? = null)

@Serializable
data class Card(
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val subtitle: String? = null,
    val priority: String,
    val url: String? = null,
    val actions: List<CardAction> = emptyList(),
    val createdAt: JsonElement? = null,
    val readAt: JsonElement? = null,
)

@Serializable
data class Cards(val cards: List<Card> = emptyList(), val now: Long = 0)

@Serializable
sealed interface NotifyOp {
    @Serializable @SerialName("read")
    data class Read(val ids: List<String>) : NotifyOp

    @Serializable @SerialName("ack")
    data class Ack(val ids: List<String>) : NotifyOp

    @Serializable @SerialName("dismiss")
    data class Dismiss(val id: String) : NotifyOp
}

@Serializable
data class Intercom(
    val ringing: Boolean,
    val ringingSince: Long? = null,
    val lastRingAt: Long? = null,
    val lastOpenAt: Long? = null,
    val autoOpenUntil: Long? = null,
    val armed: Boolean,
    val canOpen: Boolean,
    val ok: Boolean? = null,
)

@Serializable
data class IntercomAct(val action: String, val minutes: Int = 45)

@Serializable
data class Water(val ml: Int, val target: Int, val glasses: Int, val underPace: Boolean, val lastAt: Long? = null)

@Serializable
data class WaterAct(val op: String = "drink", val ml: Int = 250)

@Serializable
data class Macros(val calories: Double, val protein: Double, val carbs: Double, val fats: Double)

@Serializable
data class Meal(
    val name: String,
    val mealType: String? = null,
    val calories: Double,
    val protein: Double,
    val carbs: Double,
    val fats: Double,
    val at: Long,
)

@Serializable
data class NutritionToday(
    val day: String,
    val remaining: Macros,
    val meals: List<Meal> = emptyList(),
    val streak: Int = 0,
)

/** Error body every refusal carries: `{ ok:false, code, error }` (error is already localised). */
@Serializable
data class ApiErrorBody(val ok: Boolean = false, val code: String = "", val error: String = "")

/** POST /api/devices/pair. */
@Serializable
data class PairRequest(
    val name: String,
    val platform: String,
    val invite: String? = null,
    val email: String? = null,
    val password: String? = null,
)

@Serializable
data class PairResponse(val id: String, val token: String, val status: String, val code: String? = null)

@Serializable
data class PairStatus(val status: String, val code: String? = null)

/** POST /api/devices/pair/invite: a one-time QR link for another device of the same member. */
@Serializable
data class Invite(val link: String, val code: String, val hub: String, val expiresAt: Long)

/** GET /api/v1/app/push: how this hub can wake the app. */
@Serializable
data class PushConfig(
    val fcm: FcmOptions? = null,
    val webPush: Boolean = false,
    val vapidKey: String? = null,
)

/** Runtime FirebaseOptions handed out by the hub, so no google-services.json ships in the app. */
@Serializable
data class FcmOptions(val projectId: String, val applicationId: String, val apiKey: String, val senderId: String)

/** PUT /api/v1/app/push. */
@Serializable
sealed interface PushRegistration {
    @Serializable @SerialName("fcm")
    data class Fcm(val token: String) : PushRegistration

    @Serializable @SerialName("unifiedpush")
    data class UnifiedPush(val endpoint: String, val p256dh: String, val auth: String) : PushRegistration

    @Serializable @SerialName("none")
    data object None : PushRegistration
}
