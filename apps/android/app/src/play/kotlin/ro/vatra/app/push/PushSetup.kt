package ro.vatra.app.push

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import ro.vatra.app.VatraApp
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.model.FcmOptions
import ro.vatra.core.model.PushConfig
import ro.vatra.core.model.PushRegistration
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.RelayClient
import kotlinx.coroutines.tasks.await

/**
 * Play flavour: FCM when the hub has a Firebase project (its public client options come from
 * GET /api/v1/app/push, so no google-services.json ships and every self-hosted hub can use its own
 * project), UnifiedPush when the user picks it or the hub has no Firebase.
 * When the hub has Vatra Cloud push (`relay`), the FCM token goes to the relay instead, which hands back
 * an opaque handle for the hub; payloads are then end-to-end encrypted with a per-device key.
 */
object PushSetup {
    const val fcmAvailable = true
    const val defaultMethod = "fcm"

    suspend fun refresh(app: VatraApp, hub: PairedHub) {
        val c = app.client(hub)
        val cfg = (c.pushConfig() as? ApiResult.Ok)?.value ?: return
        val fcm = fcmOptions(cfg)
        val method = app.prefs.pushNow() ?: if (fcm != null) "fcm" else "unifiedpush"
        if (method != "fcm" || relayOf(cfg) == null) clearRelayKey(app, hub)
        when {
            method == "fcm" && fcm != null -> {
                UpRegister.unregister(app)
                // FCM 25.1+: registration by Firebase installation ID. register() is idempotent; the FID
                // arrives in FcmService.onRegistered and is sent on from there (HTTP v1 accepts it as `token`).
                runCatching { messaging(app, fcm).register().await() }
                // register() does not re-announce an unchanged ID: a hub that just enabled Vatra Cloud
                // (or switched relay hub id) still needs the relay handle.
                val relay = relayOf(cfg)
                val fid = app.prefs.fcmIdNow()
                val known = app.hubs.current().hubs.firstOrNull { it.id == hub.id }
                val registered = known != null && known.relayed && known.relayHubId == relay?.hub
                if (relay != null && fid != null && !registered) onToken(app, fid, hub)
            }
            method == "none" -> {
                UpRegister.unregister(app)
                runCatching { if (FirebaseApp.getApps(app).isNotEmpty()) FirebaseMessaging.getInstance().unregister().await() }
                c.registerPush(PushRegistration.None)
            }
            else -> if (!UpRegister.register(app, cfg.vapidKey)) c.registerPush(PushRegistration.None)
        }
    }

    /**
     * A new Firebase installation ID: relay hubs get a fresh handle (and a rotated E2E key), the rest get
     * the ID directly. Called from FcmService.onRegistered (first registration and every refresh).
     */
    suspend fun onToken(app: VatraApp, fid: String, target: PairedHub? = null) {
        app.prefs.setFcmId(fid)
        if ((app.prefs.pushNow() ?: "fcm") != "fcm") return
        val hub = target ?: app.hubs.current().active ?: return
        val c = app.client(hub)
        val relay = (c.pushConfig() as? ApiResult.Ok)?.value?.let(::relayOf)
        if (relay == null) {
            clearRelayKey(app, hub)
            c.registerPush(PushRegistration.Fcm(fid))
            return
        }
        val handle = (RelayClient(relay.url).handle("fcm", fid, relay.hub) as? ApiResult.Ok)?.value
        val reg = handle?.let { (c.registerRelayHandle("fcm", it) as? ApiResult.Ok)?.value }
        val key = reg?.e2eKey.orEmpty()
        if (key.isNotEmpty()) {
            app.hubs.update { it.withRelayKey(hub.id, relay.hub, key) }
        } else {
            // Relay unreachable or an older hub: keep the alert path working over direct FCM.
            Log.w("VatraPush", "relay registration failed, falling back to direct FCM")
            clearRelayKey(app, hub)
            c.registerPush(PushRegistration.Fcm(fid))
        }
    }

    private fun relayOf(cfg: PushConfig) = cfg.relay?.takeIf { it.usable }

    /** The relay's own Firebase project when it names one, else the hub's. */
    private fun fcmOptions(cfg: PushConfig): FcmOptions? = relayOf(cfg)?.fcm ?: cfg.fcm

    private suspend fun clearRelayKey(app: VatraApp, hub: PairedHub) {
        if (app.hubs.current().hubs.any { it.id == hub.id && it.relayed }) app.hubs.update { it.withRelayKey(hub.id, "", "") }
    }

    /**
     * The DEFAULT FirebaseApp, created from the active hub's options at runtime (FCM only serves the
     * default app). A hub on another Firebase project replaces it.
     */
    fun messaging(c: Context, o: FcmOptions): FirebaseMessaging {
        val current = FirebaseApp.getApps(c).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
        if (current != null && current.options.projectId != o.projectId) current.delete()
        if (current == null || current.options.projectId != o.projectId) {
            FirebaseApp.initializeApp(c, FirebaseOptions.Builder().setProjectId(o.projectId).setApplicationId(o.applicationId).setApiKey(o.apiKey).setGcmSenderId(o.senderId).build())
        }
        return FirebaseMessaging.getInstance()
    }
}
