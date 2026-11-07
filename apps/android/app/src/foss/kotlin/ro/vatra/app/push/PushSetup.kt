package ro.vatra.app.push

import ro.vatra.app.VatraApp
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.model.PushRegistration
import ro.vatra.core.net.ApiResult

/** FOSS flavour: no Google Play services, so UnifiedPush (ntfy, NextPush, …) or nothing. */
object PushSetup {
    const val fcmAvailable = false
    const val defaultMethod = "unifiedpush"

    suspend fun refresh(app: VatraApp, hub: PairedHub) {
        val c = app.client(hub)
        if (app.prefs.pushNow() == "none") {
            UpRegister.unregister(app)
            c.registerPush(PushRegistration.None)
            return
        }
        val cfg = (c.pushConfig() as? ApiResult.Ok)?.value
        if (!UpRegister.register(app, cfg?.vapidKey)) c.registerPush(PushRegistration.None)
    }
}
