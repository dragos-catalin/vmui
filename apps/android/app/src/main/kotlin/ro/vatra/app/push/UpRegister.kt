package ro.vatra.app.push

import android.content.Context
import org.unifiedpush.android.connector.UnifiedPush

/** Registers with the distributor the user already chose (or the system default); the endpoint arrives in [UpService]. */
object UpRegister {
    fun register(c: Context, vapid: String?): Boolean {
        val saved = UnifiedPush.getAckDistributor(c) ?: UnifiedPush.getSavedDistributor(c)
        val distributor = saved ?: UnifiedPush.getDistributors(c).firstOrNull() ?: return false
        if (saved == null) UnifiedPush.saveDistributor(c, distributor)
        UnifiedPush.register(c, vapid = vapid)
        return true
    }

    fun unregister(c: Context) {
        runCatching { UnifiedPush.unregister(c) }
    }
}
