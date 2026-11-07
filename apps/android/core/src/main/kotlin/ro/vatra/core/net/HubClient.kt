package ro.vatra.core.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import ro.vatra.core.ControlJson
import ro.vatra.core.KindJson
import ro.vatra.core.OpJson
import ro.vatra.core.WireJson
import ro.vatra.core.model.Applied
import ro.vatra.core.model.ApiErrorBody
import ro.vatra.core.model.Card
import ro.vatra.core.model.Cards
import ro.vatra.core.model.Control
import ro.vatra.core.model.Discover
import ro.vatra.core.model.HomeState
import ro.vatra.core.model.Intercom
import ro.vatra.core.model.IntercomAct
import ro.vatra.core.model.Lights
import ro.vatra.core.model.LightsOp
import ro.vatra.core.model.Me
import ro.vatra.core.model.NotifyOp
import ro.vatra.core.model.NutritionToday
import ro.vatra.core.model.Ok
import ro.vatra.core.model.PairRequest
import ro.vatra.core.model.PairResponse
import ro.vatra.core.model.PairStatus
import ro.vatra.core.model.PushConfig
import ro.vatra.core.model.PushRegistration
import ro.vatra.core.model.RelayRegistered
import ro.vatra.core.model.Water
import ro.vatra.core.model.WaterAct
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Every outcome a screen has to handle, with the hub's own localised text on refusal. */
sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>

    /** The hub answered and refused: `code` is stable (no_room_access, forbidden, …), `message` is localised. */
    data class Refused(val status: Int, val code: String, val message: String) : ApiResult<Nothing>

    /** Unreachable, timed out, or an unparseable body. */
    data class Offline(val reason: String) : ApiResult<Nothing>

    /** The hub needs a newer app (minClient above ours). */
    data class TooOld(val minClient: Int) : ApiResult<Nothing>
}

inline fun <T, R> ApiResult<T>.map(f: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Ok -> ApiResult.Ok(f(value))
    is ApiResult.Refused -> this
    is ApiResult.Offline -> this
    is ApiResult.TooOld -> this
}

fun <T> ApiResult<T>.valueOrNull(): T? = (this as? ApiResult.Ok)?.value

/**
 * The hub's app contract over HTTP. One instance per paired hub: [baseUrl] is that hub's
 * address and [token] the `vmd_` device token it issued at pairing (header only, never a query).
 */
class HubClient(
    val baseUrl: String,
    private val token: String?,
    private val language: String = "en",
    private val http: OkHttpClient = defaultHttp,
) {
    private val base = baseUrl.trimEnd('/')

    suspend fun discover(): ApiResult<Discover> = get("/api/discover", Discover.serializer(), auth = false)
    suspend fun me(): ApiResult<Me> = get("/api/v1/app/me", Me.serializer()).let(::checkVersion)
    suspend fun state(): ApiResult<HomeState> = get("/api/v1/app/state", HomeState.serializer())
    suspend fun control(c: Control): ApiResult<Ok> = post("/api/v1/app/control", ControlJson.encodeToString(Control.serializer(), c), Ok.serializer())
    suspend fun lights(): ApiResult<Lights> = get("/api/v1/app/lights", Lights.serializer())
    suspend fun lights(op: LightsOp): ApiResult<Applied> = post("/api/v1/app/lights", OpJson.encodeToString(LightsOp.serializer(), op), Applied.serializer())
    suspend fun cards(all: Boolean = false): ApiResult<Cards> = get("/api/v1/app/notify?all=${if (all) 1 else 0}&lang=$language", Cards.serializer())
    suspend fun notify(op: NotifyOp): ApiResult<Ok> = post("/api/v1/app/notify", OpJson.encodeToString(NotifyOp.serializer(), op), Ok.serializer())

    /** A button on a notification (Open door, Approve pairing, …): routed by the hub per card kind and member. */
    suspend fun act(cardId: String, action: String): ApiResult<Ok> =
        post("/api/notify/act", WireJson.encodeToString(ro.vatra.core.model.CardAct.serializer(), ro.vatra.core.model.CardAct(cardId, action)), Ok.serializer())
    suspend fun intercom(): ApiResult<Intercom> = get("/api/v1/app/intercom", Intercom.serializer())
    suspend fun intercom(act: IntercomAct): ApiResult<Intercom> = post("/api/v1/app/intercom", WireJson.encodeToString(IntercomAct.serializer(), act), Intercom.serializer())
    suspend fun water(): ApiResult<Water> = get("/api/v1/app/nutrition/water", Water.serializer())
    suspend fun water(act: WaterAct): ApiResult<Water> = post("/api/v1/app/nutrition/water", WireJson.encodeToString(WaterAct.serializer(), act), Water.serializer())
    suspend fun nutrition(): ApiResult<NutritionToday> = get("/api/v1/app/nutrition/today", NutritionToday.serializer())
    suspend fun pushConfig(): ApiResult<PushConfig> = get("/api/v1/app/push", PushConfig.serializer())
    suspend fun presence(state: String, source: String): ApiResult<ro.vatra.core.model.PresenceResult> =
        post("/api/v1/app/presence", WireJson.encodeToString(ro.vatra.core.model.PresenceReport.serializer(), ro.vatra.core.model.PresenceReport(state, source)), ro.vatra.core.model.PresenceResult.serializer())
    suspend fun registerPush(r: PushRegistration): ApiResult<Ok> =
        send("PUT", "/api/v1/app/push", KindJson.encodeToString(PushRegistration.serializer(), r), Ok.serializer())

    /**
     * Registers a Vatra Cloud relay handle; the hub answers with a fresh per-device `e2eKey` (rotated
     * on every call), which must be stored before the next push arrives.
     */
    suspend fun registerRelayHandle(platform: String, handle: String, activityHandle: String? = null): ApiResult<RelayRegistered> =
        send("PUT", "/api/v1/app/push", relayRegistration(platform, handle, activityHandle).toString(), RelayRegistered.serializer())

    /** One card by id (a relay push too large to carry it); same shape and visibility as an item of [cards]. */
    suspend fun pushCard(id: String): ApiResult<Card> {
        val q = URLEncoder.encode(id, "UTF-8")
        return get("/api/v1/app/push/card?id=$q&lang=$language", Card.serializer())
    }

    suspend fun pair(req: PairRequest): ApiResult<PairResponse> =
        send("POST", "/api/devices/pair", WireJson.encodeToString(PairRequest.serializer(), req), PairResponse.serializer(), auth = false)

    suspend fun pairStatus(id: String): ApiResult<PairStatus> = get("/api/devices/pair?id=$id", PairStatus.serializer(), auth = false)

    /** Mints an invite bound to this device's member, for the watch / TV / another phone. */
    suspend fun invite(): ApiResult<ro.vatra.core.model.Invite> = send("POST", "/api/devices/pair/invite", "{}", ro.vatra.core.model.Invite.serializer())

    /**
     * Erases this device's member (account, nutrition journal, AI consent, every paired device).
     * Refusals: owner_cannot_delete 409, wrong_password 403, not_bound 403, rate_limited 429, demo_readonly 403.
     */
    suspend fun deleteAccount(password: String): ApiResult<Ok> =
        post("/api/v1/app/account/delete", WireJson.encodeToString(ro.vatra.core.model.AccountDeleteRequest.serializer(), ro.vatra.core.model.AccountDeleteRequest(password)), Ok.serializer())

    private fun checkVersion(r: ApiResult<Me>): ApiResult<Me> =
        if (r is ApiResult.Ok && r.value.minClient > CLIENT_API) ApiResult.TooOld(r.value.minClient) else r

    private suspend fun <T> get(path: String, s: KSerializer<T>, auth: Boolean = true) = send("GET", path, null, s, auth)
    private suspend fun <T> post(path: String, body: String, s: KSerializer<T>) = send("POST", path, body, s, true)

    private suspend fun <T> send(method: String, path: String, body: String?, s: KSerializer<T>, auth: Boolean = true): ApiResult<T> {
        val url = "$base$path".toHttpUrlOrNull() ?: return ApiResult.Offline("bad url")
        val req = Request.Builder().url(url)
            .header("Accept", "application/json")
            .header("Accept-Language", language)
            .header("x-vatra-client", CLIENT_API.toString())
            .apply { if (auth && token != null) header("Authorization", "Bearer $token") }
            .method(method, body?.toRequestBody(JSON))
            .build()
        return withContext(Dispatchers.IO) {
            try {
                http.newCall(req).await().use { res -> decode(res, s) }
            } catch (e: IOException) {
                ApiResult.Offline(e.javaClass.simpleName)
            }
        }
    }

    companion object {
        /** The app-contract version this build speaks (src/lib/api-version.ts API_VERSION). */
        const val CLIENT_API = 2

        /** PUT /api/v1/app/push kind relay; `activityHandle` is sent as an explicit null (WireJson would drop it). */
        fun relayRegistration(platform: String, handle: String, activityHandle: String? = null) = buildJsonObject {
            put("kind", "relay")
            put("platform", platform)
            put("handle", handle)
            put("activityHandle", activityHandle?.let(::JsonPrimitive) ?: JsonNull)
        }

        private val JSON = "application/json".toMediaType()
        val defaultHttp: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .callTimeout(20, TimeUnit.SECONDS)
            .build()

        fun <T> decode(res: Response, s: KSerializer<T>, json: Json = WireJson): ApiResult<T> {
            val text = res.body.string()
            if (res.isSuccessful) {
                return runCatching { ApiResult.Ok(json.decodeFromString(s, text)) }
                    .getOrElse { ApiResult.Offline("decode: ${it.javaClass.simpleName}") }
            }
            val err = runCatching { json.decodeFromString(ApiErrorBody.serializer(), text) }.getOrNull()
            return ApiResult.Refused(res.code, err?.code?.ifEmpty { null } ?: "http_${res.code}", err?.error.orEmpty())
        }
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
