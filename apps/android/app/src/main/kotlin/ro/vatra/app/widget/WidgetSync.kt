package ro.vatra.app.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import ro.vatra.core.home.HomeView
import ro.vatra.core.model.HomeState
import ro.vatra.core.model.Water

/** Last numbers the widget draws; written by the app on every refresh, read without network. */
object WidgetSync {
    private const val FILE = "vatra_widget"

    data class Snapshot(val home: String, val lightsOn: Int, val rooms: Int, val waterMl: Int, val waterTarget: Int)

    fun store(c: Context, s: HomeState, w: Water?) {
        val sp = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val lights = HomeView.lightsOn(s)
        val changed = sp.getInt("lights", -1) != lights || sp.getInt("water", -1) != (w?.ml ?: 0)
        sp.edit().putInt("lights", lights).putInt("rooms", s.rooms.size).putInt("water", w?.ml ?: 0).putInt("target", w?.target ?: 0).apply()
        if (changed) CoroutineScope(Dispatchers.Default).launch { runCatching { HouseWidget().updateAll(c) } }
    }

    fun read(c: Context, home: String): Snapshot {
        val sp = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        return Snapshot(home, sp.getInt("lights", 0), sp.getInt("rooms", 0), sp.getInt("water", 0), sp.getInt("target", 0))
    }
}
