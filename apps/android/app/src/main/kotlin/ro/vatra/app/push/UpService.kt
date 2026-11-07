package ro.vatra.app.push

import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import ro.vatra.app.VatraApp
import ro.vatra.core.model.PushRegistration
import ro.vatra.core.push.PushPayload

/**
 * UnifiedPush receiver (both flavours). The connector decrypts the RFC 8291 message with the keys it
 * generated; the endpoint and the public keys go to the hub (PUT /api/v1/app/push) so it can encrypt.
 */
class UpService : PushService() {
    private val app get() = VatraApp.from(this)

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val keys = endpoint.pubKeySet ?: return
        app.scope.launch {
            app.activeClient()?.registerPush(PushRegistration.UnifiedPush(endpoint.url, keys.pubKey, keys.auth))
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val p = PushPayload.fromJson(message.content) ?: return
        app.scope.launch { Incoming.handle(this@UpService, p) }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) = Unit

    override fun onUnregistered(instance: String) {
        app.scope.launch { app.activeClient()?.registerPush(PushRegistration.None) }
    }
}
