package ro.vatra.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch
import ro.vatra.app.VatraApp
import ro.vatra.core.push.PushPayload

/**
 * FCM data messages: direct from the hub (src/lib/notify/fcm.ts) or via the Vatra Cloud relay (`e` =
 * end-to-end encrypted card). The installation ID is sent on every (re)registration.
 */
class FcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val app = VatraApp.from(this)
        if (!data["e"].isNullOrEmpty()) {
            app.scope.launch { Incoming.handleRelay(this@FcmService, data) }
            return
        }
        val p = PushPayload.fromMap(data) ?: return
        app.scope.launch { Incoming.handle(this@FcmService, p) }
    }

    override fun onRegistered(fid: String) {
        val app = VatraApp.from(this)
        app.scope.launch { runCatching { PushSetup.onToken(app, fid) } }
    }
}
