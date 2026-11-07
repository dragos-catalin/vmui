package ro.vatra.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ro.vatra.app.VatraApp
import ro.vatra.app.widget.WidgetSync
import ro.vatra.core.action.QuickAction
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.model.Cards
import ro.vatra.core.model.Control
import ro.vatra.core.model.HomeState
import ro.vatra.core.model.Intercom
import ro.vatra.core.model.IntercomAct
import ro.vatra.core.model.Lights
import ro.vatra.core.model.LightsOp
import ro.vatra.core.model.Me
import ro.vatra.core.model.NotifyOp
import ro.vatra.core.model.Water
import ro.vatra.core.model.WaterAct
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient

/** Everything the phone shows about the active hub; refreshed while the app is in front. */
data class HomeUi(
    val hub: PairedHub? = null,
    val me: Me? = null,
    val state: HomeState? = null,
    val lights: Lights? = null,
    val cards: Cards? = null,
    val intercom: Intercom? = null,
    val water: Water? = null,
    val offline: Boolean = false,
    val tooOld: Boolean = false,
    /** Last refusal text from the hub (already in the device language), shown once as a snackbar. */
    val message: String? = null,
    val loading: Boolean = true,
)

class HomeModel(app: Application) : AndroidViewModel(app) {
    private val va = VatraApp.from(app)
    private val _ui = MutableStateFlow(HomeUi())
    val ui: StateFlow<HomeUi> = _ui.asStateFlow()
    private var poll: Job? = null

    init {
        viewModelScope.launch {
            va.active.collect { hub ->
                _ui.value = HomeUi(hub = hub, loading = hub != null)
                restart()
            }
        }
    }

    private fun client(): HubClient? = _ui.value.hub?.let(va::client)

    /** Polls every 5 s while visible (the SSE stream stays a web-only surface). */
    fun restart() {
        poll?.cancel()
        val c = client() ?: return
        poll = viewModelScope.launch {
            while (isActive) {
                refresh(c)
                delay(5_000)
            }
        }
    }

    fun stop() {
        poll?.cancel()
    }

    private suspend fun refresh(c: HubClient) {
        val me = c.me()
        if (me is ApiResult.TooOld) return _ui.update { it.copy(tooOld = true, loading = false) }
        val state = c.state()
        val offline = state is ApiResult.Offline
        _ui.update {
            it.copy(
                me = (me as? ApiResult.Ok)?.value ?: it.me,
                state = (state as? ApiResult.Ok)?.value ?: it.state,
                lights = (c.lights() as? ApiResult.Ok)?.value ?: it.lights,
                cards = (c.cards() as? ApiResult.Ok)?.value ?: it.cards,
                intercom = (c.intercom() as? ApiResult.Ok)?.value ?: it.intercom,
                water = (c.water() as? ApiResult.Ok)?.value ?: it.water,
                offline = offline,
                loading = false,
            )
        }
        _ui.value.state?.let { WidgetSync.store(getApplication(), it, _ui.value.water) }
    }

    private fun act(block: suspend (HubClient) -> ApiResult<*>) {
        val c = client() ?: return
        viewModelScope.launch {
            when (val r = block(c)) {
                is ApiResult.Refused -> _ui.update { it.copy(message = r.message.ifEmpty { r.code }) }
                is ApiResult.Offline -> _ui.update { it.copy(offline = true) }
                else -> Unit
            }
            refresh(c)
        }
    }

    fun toggle(entity: String, on: Boolean) = act { it.control(Control.Toggle(entity, on)) }
    fun brightness(entity: String, pct: Int) = act { it.control(Control.SetLight(entity, brightnessPct = pct.coerceIn(1, 100))) }
    fun scene(id: String) = act { it.lights(LightsOp.ApplyScene(id)) }
    fun lightsTarget(target: String, on: Boolean) = act { it.lights(LightsOp.Set(target, ro.vatra.core.model.LightState(on = on))) }
    fun ambilight(mode: String) = act { it.control(Control.Ambilight(mode)) }
    fun script(name: String) = act { it.control(Control.Script(name)) }
    fun door(action: String) = act { it.intercom(IntercomAct(action)) }
    fun drink() = act { it.water(WaterAct("drink")) }
    fun undoDrink() = act { it.water(WaterAct("undo")) }
    fun dismiss(id: String) = act { it.notify(NotifyOp.Dismiss(id)) }
    fun cardAction(id: String, action: String) = act { it.act(id, action) }
    fun quick(a: QuickAction) = act { a.run(it) }
    fun consumeMessage() = _ui.update { it.copy(message = null) }
}
