package ro.vatra.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.vatra.core.action.QuickAction
import ro.vatra.core.home.HomeView
import ro.vatra.core.model.Device
import ro.vatra.core.model.EntityState
import ro.vatra.core.model.HomeState
import ro.vatra.core.model.Room
import ro.vatra.core.push.PushPayload

class ActionsTest {
    @Test fun quickActionsRoundTrip() {
        val all = listOf(
            QuickAction.Scene("evening & calm"),
            QuickAction.Toggle("light.bed_lamp", true),
            QuickAction.Toggle("switch.kettle", false),
            QuickAction.Script("pc_wake"),
            QuickAction.Ambilight("movie"),
            QuickAction.Water,
            QuickAction.DoorIgnore,
        )
        for (a in all) assertEquals(a, QuickAction.parse(a.toUri()))
    }

    @Test fun tagsCannotSmuggleAnythingOutsideTheAllowLists() {
        assertNull(QuickAction.parse("vatra://do?a=script&n=rm_rf"))
        assertNull(QuickAction.parse("vatra://do?a=toggle&e=light.x;drop&on=1"))
        assertNull(QuickAction.parse("vatra://do?a=ambilight&m=strobe"))
        assertNull(QuickAction.parse("vatra://do?a=open-door"))
        assertNull(QuickAction.parse("https://evil/do?a=water"))
        assertNull(QuickAction.parse("vatra://pair?h=x&c=y"))
    }

    @Test fun fcmMapAndUnifiedPushJsonGiveTheSamePayload() {
        val m = mapOf(
            "type" to "card", "id" to "c1", "kind" to "intercom", "tag" to "door", "title" to "Sună", "body" to "", "priority" to "high",
            "actions" to """[{"id":"open","label":"Deschide","style":"primary"}]""", "sticky" to "0", "at" to "1700000000000",
        )
        val a = PushPayload.fromMap(m)!!
        val json = JsonObject(m.mapValues { JsonPrimitive(it.value) }).toString().encodeToByteArray()
        val b = PushPayload.fromJson(json)!!
        assertEquals(a, b)
        assertTrue(a.isIntercomRing)
        assertEquals("open", a.actions.single().id)
        assertEquals("door".hashCode(), a.notificationId)
    }

    @Test fun payloadEdgeCases() {
        assertNull(PushPayload.fromMap(mapOf("title" to "no id")))
        assertNull(PushPayload.fromJson("not json".encodeToByteArray()))
        val d = PushPayload.fromMap(mapOf("type" to "dismiss", "id" to "c1", "kind" to "intercom", "priority" to "high", "actions" to "garbage"))!!
        assertTrue(d.isDismiss)
        assertFalse(d.isIntercomRing)
        assertTrue(d.actions.isEmpty())
        assertTrue(PushPayload.fromMap(mapOf("id" to "c", "fetch" to "1"))!!.needsFetch)
    }

    @Test fun homeViewDerivesTilesAndPermissions() {
        val s = HomeState(
            rooms = listOf(Room("bed", "Bedroom", "control"), Room("kit", "Kitchen", "view")),
            devices = listOf(
                Device("lamp", "Lamp", "light", "bed", "light.lamp"),
                Device("ac", "AC", "climate", "bed", "climate.ac"),
                Device("hood", "Hood", "light", "kit", "light.hood"),
                Device("door", "Door", "sensor", "kit", "binary_sensor.door"),
                Device("dead", "Dead", "light", "bed", "light.dead"),
            ),
            states = mapOf(
                "light.lamp" to EntityState("on", JsonObject(mapOf("brightness" to JsonPrimitive(128)))),
                "climate.ac" to EntityState("cool"),
                "light.hood" to EntityState("on"),
                "binary_sensor.door" to EntityState("off"),
                "light.dead" to EntityState("unavailable"),
            ),
            haOnline = true,
        )
        val rooms = HomeView.rooms(s)
        val bed = rooms.first { it.id == "bed" }
        val lamp = bed.devices.first { it.id == "lamp" }
        assertEquals(50, lamp.brightnessPct)
        assertTrue(lamp.toggleable)
        assertEquals(true, bed.devices.first { it.id == "ac" }.on)
        val dead = bed.devices.first { it.id == "dead" }
        assertFalse(dead.available)
        assertFalse(dead.toggleable)
        val kit = rooms.first { it.id == "kit" }
        assertFalse(kit.devices.first { it.id == "hood" }.toggleable)
        assertNull(kit.devices.first { it.id == "door" }.on)
        assertEquals(2, HomeView.lightsOn(s))
    }
}
