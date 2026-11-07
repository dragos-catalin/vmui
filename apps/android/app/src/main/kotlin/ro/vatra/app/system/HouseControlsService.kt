package ro.vatra.app.system

import android.app.PendingIntent
import android.content.Intent
import android.service.controls.Control
import android.service.controls.ControlsProviderService
import android.service.controls.DeviceTypes
import android.service.controls.actions.BooleanAction
import android.service.controls.actions.ControlAction
import android.service.controls.actions.FloatAction
import android.service.controls.templates.ControlButton
import android.service.controls.templates.RangeTemplate
import android.service.controls.templates.ToggleRangeTemplate
import android.service.controls.templates.ToggleTemplate
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.jdk9.asPublisher
import ro.vatra.app.MainActivity
import ro.vatra.app.VatraApp
import ro.vatra.core.home.DeviceTile
import ro.vatra.core.home.HomeView
import ro.vatra.core.model.Control as HubControl
import ro.vatra.core.net.ApiResult
import java.util.concurrent.Flow
import java.util.function.Consumer

/**
 * Android Device Controls (power menu / Home controls panel): every toggleable device the member may
 * see, grouped by room. Lights with a brightness get a range slider. Control = this device's permissions.
 */
class HouseControlsService : ControlsProviderService() {
    private val app get() = VatraApp.from(this)
    private val updates = MutableSharedFlow<Control>(extraBufferCapacity = 64)

    private fun open(): PendingIntent = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)

    private fun type(d: DeviceTile) = when (d.kind) {
        "light" -> DeviceTypes.TYPE_LIGHT
        "climate" -> DeviceTypes.TYPE_AC_HEATER
        "fan" -> DeviceTypes.TYPE_FAN
        "tv", "media" -> DeviceTypes.TYPE_TV
        else -> DeviceTypes.TYPE_SWITCH
    }

    private fun stateless(d: DeviceTile, room: String) =
        Control.StatelessBuilder(d.entity!!, open()).setTitle(d.name).setZone(room).setDeviceType(type(d)).build()

    private fun stateful(d: DeviceTile, room: String): Control {
        val entity = d.entity!!
        val bri = d.brightnessPct
        val toggle = ControlButton(d.on == true, d.name)
        val template = if (d.kind == "light" && bri != null) {
            ToggleRangeTemplate(entity, toggle, RangeTemplate("$entity.b", 1f, 100f, bri.toFloat(), 1f, "%.0f%%"))
        } else {
            ToggleTemplate(entity, toggle)
        }
        return Control.StatefulBuilder(entity, open())
            .setTitle(d.name)
            .setZone(room)
            .setDeviceType(type(d))
            .setStatus(if (d.available) Control.STATUS_OK else Control.STATUS_DISABLED)
            .setControlTemplate(template)
            .build()
    }

    override fun createPublisherForAllAvailable(): Flow.Publisher<Control> {
        val flow = kotlinx.coroutines.flow.flow {
            val c = app.activeClient()
            val s = c?.state()?.let { (it as? ApiResult.Ok)?.value }
            if (s != null) for (r in HomeView.rooms(s)) for (d in r.devices) if (d.on != null && d.entity != null) emit(stateless(d, r.name))
        }
        return flow.asPublisher()
    }

    override fun createPublisherFor(controlIds: List<String>): Flow.Publisher<Control> {
        app.scope.launch { push(controlIds) }
        return updates.asPublisher()
    }

    private suspend fun push(ids: List<String>) {
        val c = app.activeClient() ?: return
        val s = (c.state() as? ApiResult.Ok)?.value ?: return
        for (r in HomeView.rooms(s)) for (d in r.devices) if (d.entity in ids && d.on != null) updates.emit(stateful(d, r.name))
    }

    override fun performControlAction(controlId: String, action: ControlAction, consumer: Consumer<Int>) {
        consumer.accept(ControlAction.RESPONSE_OK)
        app.scope.launch {
            val c = app.activeClient() ?: return@launch
            when (action) {
                is BooleanAction -> c.control(HubControl.Toggle(controlId, action.newState))
                is FloatAction -> c.control(HubControl.SetLight(controlId.removeSuffix(".b"), brightnessPct = action.newValue.toInt().coerceIn(1, 100)))
                else -> return@launch
            }
            push(listOf(controlId.removeSuffix(".b")))
        }
    }
}
