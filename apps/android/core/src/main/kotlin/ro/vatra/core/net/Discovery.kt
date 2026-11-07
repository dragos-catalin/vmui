package ro.vatra.core.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** A hub advertising `_vatra._tcp` (pi/avahi-vmui.service, deploy/vatra hub-install.sh). */
data class DiscoveredHub(val name: String, val host: String, val port: Int, val version: String?) {
    val baseUrl: String get() = "http://${if (host.contains(':')) "[$host]" else host}${if (port == 80) "" else ":$port"}"
}

/**
 * Finds hubs on this network over mDNS. Holds a multicast lock only while collected:
 * Wi-Fi drivers drop multicast to save power, and keeping it after the add-hub screen
 * closes would cost battery for nothing. Same shape as the Vitals app's discovery.
 */
class Discovery(context: Context) {
    private val app = context.applicationContext
    private val nsd = app.getSystemService(NsdManager::class.java)
    private val wifi: WifiManager? = app.getSystemService(WifiManager::class.java)

    fun scan(): Flow<List<DiscoveredHub>> = callbackFlow {
        val found = linkedMapOf<String, DiscoveredHub>()
        val lock = wifi?.createMulticastLock("vatra-discovery")?.apply {
            setReferenceCounted(false)
            acquire()
        }
        // NSD calls back on its own threads; the map is touched only here.
        val executor = Executors.newSingleThreadExecutor()
        val callbacks = CopyOnWriteArrayList<NsdManager.ServiceInfoCallback>()

        fun onExecutor(block: () -> Unit) {
            runCatching { executor.execute(block) }
        }

        fun publish() = trySend(found.values.toList())

        fun resolved(info: NsdServiceInfo) = onExecutor {
            val host = hostOf(info) ?: return@onExecutor
            found[info.serviceName] = DiscoveredHub(info.serviceName, host, info.port, info.attributes["version"]?.decodeToString())
            publish()
        }

        fun lost(name: String) = onExecutor {
            found.remove(name)
            publish()
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(info: NsdServiceInfo) {
                if (Build.VERSION.SDK_INT >= 34) {
                    val cb = object : NsdManager.ServiceInfoCallback {
                        override fun onServiceUpdated(updated: NsdServiceInfo) = resolved(updated)
                        override fun onServiceLost() = lost(info.serviceName)
                        override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit
                        override fun onServiceInfoCallbackUnregistered() = Unit
                    }
                    runCatching { nsd.registerServiceInfoCallback(info, executor, cb) }.onSuccess { callbacks += cb }
                } else {
                    @Suppress("DEPRECATION")
                    nsd.resolveService(info, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = Unit
                        override fun onServiceResolved(info: NsdServiceInfo) = resolved(info)
                    })
                }
            }

            override fun onServiceLost(info: NsdServiceInfo) = lost(info.serviceName)
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                close()
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }

        onExecutor { publish() }
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        awaitClose {
            runCatching { nsd.stopServiceDiscovery(listener) }
            if (Build.VERSION.SDK_INT >= 34) callbacks.forEach { runCatching { nsd.unregisterServiceInfoCallback(it) } }
            executor.shutdown()
            lock?.release()
        }
    }

    private fun hostOf(info: NsdServiceInfo): String? =
        if (Build.VERSION.SDK_INT >= 34) {
            info.hostAddresses.firstOrNull { it is java.net.Inet4Address }?.hostAddress ?: info.hostAddresses.firstOrNull()?.hostAddress
        } else {
            @Suppress("DEPRECATION")
            info.host?.hostAddress
        }

    companion object {
        const val SERVICE_TYPE = "_vatra._tcp."
    }
}
