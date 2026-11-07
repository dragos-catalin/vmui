package ro.vatra.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch
import ro.vatra.app.VatraApp
import ro.vatra.core.model.PushRegistration
import ro.vatra.core.push.PushPayload

/** FCM data messages from the hub (src/lib/notify/fcm.ts); the installation ID is posted on every (re)registration. */
class FcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val p = PushPayload.fromMap(message.data) ?: return
        val app = VatraApp.from(this)
        app.scope.launch { Incoming.handle(this@FcmService, p) }
    }

    override fun onRegistered(fid: String) {
        val app = VatraApp.from(this)
        app.scope.launch {
            if ((app.prefs.pushNow() ?: "fcm") == "fcm") app.activeClient()?.registerPush(PushRegistration.Fcm(fid))
        }
    }
}
