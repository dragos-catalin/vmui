package ro.vatra.app.system

import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import kotlinx.coroutines.launch
import ro.vatra.app.R
import ro.vatra.app.VatraApp
import ro.vatra.core.action.QuickAction
import ro.vatra.core.net.ApiResult

/**
 * Quick Settings tile: one house action (default: ambilight movie / off toggle). Runs through the
 * paired device token, so a child's phone can only do what that child may do.
 */
class SceneTileService : TileService() {
    override fun onStartListening() {
        qsTile?.apply {
            label = getString(R.string.tile_label)
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    override fun onClick() {
        val app = VatraApp.from(this)
        val tile = qsTile ?: return
        val turningOn = tile.state != Tile.STATE_ACTIVE
        app.scope.launch {
            val chosen = app.prefs.tileNow()?.let(QuickAction::parse)
            val action = chosen ?: QuickAction.Ambilight(if (turningOn) "movie" else "off")
            val ok = app.activeClient()?.let { action.run(it) } is ApiResult.Ok
            tile.state = if (ok && chosen == null && turningOn) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            tile.updateTile()
        }
    }
}
