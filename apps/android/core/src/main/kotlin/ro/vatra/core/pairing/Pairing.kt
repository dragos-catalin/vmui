package ro.vatra.core.pairing

import kotlinx.coroutines.delay
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient
import ro.vatra.core.model.PairRequest

/** Where a pairing attempt is; the UI renders one screen per state. */
sealed interface PairState {
    data object Working : PairState

    /** Waiting for someone signed in to approve; they compare this code with the one on the phone. */
    data class AwaitingApproval(val code: String) : PairState

    data class Paired(val hub: PairedHub) : PairState

    /** `code` is the hub's stable error code (invite_invalid, bad_credentials, rate_limited, …) or offline/rejected/expired/too_old/not_vatra. */
    data class Failed(val code: String, val message: String = "") : PairState
}

/**
 * The three ways a phone joins a hub (src/app/api/devices/pair/route.ts):
 * a QR invite (instant, bound to the member who showed it), the account e-mail + password
 * (instant), or a plain request someone approves by comparing a 4-digit code.
 */
class Pairing(
    private val deviceName: String,
    private val language: String,
    private val platform: String = PLATFORM,
    private val client: (String, String?) -> HubClient = { url, token -> HubClient(url, token, language) },
    private val pollMs: Long = 2_000,
    private val timeoutMs: Long = 10 * 60_000,
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun withInvite(link: PairLink, onState: (PairState) -> Unit = {}): PairState =
        run(link.hub, PairRequest(deviceName, platform, invite = link.invite), onState)

    suspend fun withLogin(hub: String, email: String, password: String, onState: (PairState) -> Unit = {}): PairState =
        run(hub, PairRequest(deviceName, platform, email = email, password = password), onState)

    suspend fun withApproval(hub: String, onState: (PairState) -> Unit = {}): PairState =
        run(hub, PairRequest(deviceName, platform), onState)

    private suspend fun run(rawHub: String, req: PairRequest, onState: (PairState) -> Unit): PairState {
        val hub = PairLink.normaliseHub(rawHub) ?: return PairState.Failed("bad_address").also(onState)
        onState(PairState.Working)
        val anon = client(hub, null)
        // Talk only to a Vatra hub that this build understands, before sending any secret.
        when (val d = anon.discover()) {
            is ApiResult.Ok -> {
                if (d.value.product != "vatra" && d.value.app != "vmui") return PairState.Failed("not_vatra").also(onState)
                if (d.value.minClient > HubClient.CLIENT_API) return PairState.Failed("too_old").also(onState)
            }
            is ApiResult.Refused -> return PairState.Failed("not_vatra").also(onState)
            else -> return PairState.Failed("offline").also(onState)
        }
        val start = when (val r = anon.pair(req)) {
            is ApiResult.Ok -> r.value
            is ApiResult.Refused -> return PairState.Failed(r.code, r.message).also(onState)
            is ApiResult.TooOld -> return PairState.Failed("too_old").also(onState)
            is ApiResult.Offline -> return PairState.Failed("offline").also(onState)
        }
        if (start.status != "approved") {
            onState(PairState.AwaitingApproval(start.code.orEmpty()))
            val deadline = now() + timeoutMs
            while (true) {
                if (now() > deadline) return PairState.Failed("expired").also(onState)
                delay(pollMs)
                val s = anon.pairStatus(start.id).valueOrNull() ?: continue
                if (s.status == "approved") break
                if (s.status == "rejected" || s.status == "revoked") return PairState.Failed("rejected").also(onState)
            }
        }
        val me = client(hub, start.token).me()
        val member = (me as? ApiResult.Ok)?.value?.member?.displayName.orEmpty()
        val name = (anon.discover() as? ApiResult.Ok)?.value?.host?.ifEmpty { null } ?: hub.substringAfter("://")
        val paired = PairedHub(id = start.id, name = name, baseUrl = hub, token = start.token, deviceId = start.id, memberName = member, addedAt = now())
        return PairState.Paired(paired).also(onState)
    }

    private fun <T> ApiResult<T>.valueOrNull(): T? = (this as? ApiResult.Ok)?.value

    companion object {
        /** Distinct from the Tauri app ("android") and the Vitals apps; watch and TV use vatra-wear / vatra-tv. */
        const val PLATFORM = "vatra-android"
        const val PLATFORM_WEAR = "vatra-wear"
        const val PLATFORM_TV = "vatra-tv"
    }
}
