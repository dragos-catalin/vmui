package ro.vatra.app

import android.app.Application
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import ro.vatra.app.push.Notifier
import ro.vatra.app.push.PushSetup
import ro.vatra.core.hub.HubList
import ro.vatra.core.hub.HubStore
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.net.HubClient

/** App-wide graph: the paired hubs and a client for the active one. No DI framework for a dozen objects. */
class VatraApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    lateinit var hubs: HubStore
        private set
    lateinit var hubList: StateFlow<HubList>
        private set
    val prefs by lazy { AppPrefs(this) }

    override fun onCreate() {
        super.onCreate()
        hubs = HubStore(this)
        hubList = hubs.hubs.stateIn(scope, SharingStarted.Eagerly, HubList())
        Notifier.createChannels(this)
        // Decrypting the hub list and re-registering push happen off the main thread (cold start).
        scope.launch { hubs.current().active?.let { PushSetup.refresh(this@VatraApp, it) } }
    }

    val active: StateFlow<PairedHub?> by lazy { hubList.map { it.active }.stateIn(scope, SharingStarted.Eagerly, null) }

    fun client(hub: PairedHub): HubClient = HubClient(hub.baseUrl, hub.token, language(this))

    suspend fun activeClient(): HubClient? = hubs.current().active?.let(::client)

    companion object {
        fun from(c: Context): VatraApp = c.applicationContext as VatraApp

        /** The UI language the hub should render cards and errors in (`en` | `ro`); follows the per-app language. */
        fun language(c: Context): String = if (c.resources.configuration.locales[0].language == "ro") "ro" else "en"
    }
}
