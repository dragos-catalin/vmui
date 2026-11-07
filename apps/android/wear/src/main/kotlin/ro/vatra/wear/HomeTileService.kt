package ro.vatra.wear

import android.content.ComponentName
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material3.MaterialScope
import androidx.wear.protolayout.material3.Typography
import androidx.wear.protolayout.material3.materialScope
import androidx.wear.protolayout.material3.primaryLayout
import androidx.wear.protolayout.material3.text
import androidx.wear.protolayout.material3.textEdgeButton
import androidx.wear.protolayout.modifiers.clickable
import androidx.wear.protolayout.types.LayoutString
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.guava.future

/** The house at a glance: lights on and today's water; tap opens the app. */
class HomeTileService : TileService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> = scope.future {
        val g = WearApp.from(this@HomeTileService).glance()
        val layout = materialScope(this@HomeTileService, requestParams.deviceConfiguration) { layout(g) }
        TileBuilders.Tile.Builder()
            .setResourcesVersion("1")
            .setFreshnessIntervalMillis(5 * 60_000L)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout))
            .build()
    }

    override fun onTileResourcesRequest(requestParams: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
        scope.future { ResourceBuilders.Resources.Builder().setVersion("1").build() }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun MaterialScope.layout(g: WearApp.Glance?): LayoutElementBuilders.LayoutElement {
        val s = this@HomeTileService
        val open = clickable(ActionBuilders.launchAction(ComponentName(this@HomeTileService, MainActivity::class.java)), "open")
        val main = when {
            g == null -> s.getString(R.string.tile_empty)
            else -> listOfNotNull(
                g.lightsOn?.let { s.getString(R.string.lights_on, it) },
                g.water?.let { s.getString(R.string.water_short, it.ml, it.target) },
            ).joinToString("\n")
        }
        return primaryLayout(
            titleSlot = { text(s.getString(R.string.app_name).let(::LayoutString), maxLines = 1) },
            mainSlot = { text(main.let(::LayoutString), typography = Typography.BODY_MEDIUM, maxLines = 3) },
            bottomSlot = { textEdgeButton(onClick = open) { text(s.getString(R.string.open).let(::LayoutString)) } },
        )
    }
}
