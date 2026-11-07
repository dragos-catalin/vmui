package ro.vatra.wear

import android.app.Application
import android.content.Context
import ro.vatra.core.hub.HubStore
import ro.vatra.core.home.HomeView
import ro.vatra.core.model.HomeState
import ro.vatra.core.model.Water
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient

/** The watch keeps its own paired hub (its own `vmd_` token as a separate device of the same member). */
class WearApp : Application() {
    lateinit var hubs: HubStore
        private set

    override fun onCreate() {
        super.onCreate()
        hubs = HubStore(this)
    }

    suspend fun client(): HubClient? = hubs.current().active?.let { HubClient(it.baseUrl, it.token, language(this)) }

    /** Small summary the tile and complications draw; null when not paired or unreachable. */
    suspend fun glance(): Glance? {
        val c = client() ?: return null
        val s = (c.state() as? ApiResult.Ok)?.value
        val w = (c.water() as? ApiResult.Ok)?.value
        if (s == null && w == null) return null
        return Glance(s?.let(HomeView::lightsOn), w, s)
    }

    data class Glance(val lightsOn: Int?, val water: Water?, val state: HomeState?)

    companion object {
        fun from(c: Context): WearApp = c.applicationContext as WearApp
        fun language(c: Context): String = if (c.resources.configuration.locales[0].language == "ro") "ro" else "en"
    }
}
