package ro.vatra.app.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import ro.vatra.app.VatraApp
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.model.FcmOptions
import ro.vatra.core.model.PushRegistration
import ro.vatra.core.net.ApiResult
import kotlinx.coroutines.tasks.await

/**
 * Play flavour: FCM when the hub has a Firebase project (its public client options come from
 * GET /api/v1/app/push, so no google-services.json ships and every self-hosted hub can use its own
 * project), UnifiedPush when the user picks it or the hub has no Firebase.
 */
object PushSetup {
    const val fcmAvailable = true
    const val defaultMethod = "fcm"

    suspend fun refresh(app: VatraApp, hub: PairedHub) {
        val c = app.client(hub)
        val cfg = (c.pushConfig() as? ApiResult.Ok)?.value ?: return
        val method = app.prefs.pushNow() ?: if (cfg.fcm != null) "fcm" else "unifiedpush"
        when {
            method == "fcm" && cfg.fcm != null -> {
                UpRegister.unregister(app)
                // FCM 25.1+: registration by Firebase installation ID. register() is idempotent; the FID
                // arrives in FcmService.onRegistered and is sent to the hub there (HTTP v1 accepts it as `token`).
                runCatching { messaging(app, cfg.fcm!!).register().await() }
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
