package ro.vatra.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.vatra.core.model.Applied
import ro.vatra.core.model.Cards
import ro.vatra.core.model.Control
import ro.vatra.core.model.HomeState
import ro.vatra.core.model.Intercom
import ro.vatra.core.model.IntercomAct
import ro.vatra.core.model.Lights
import ro.vatra.core.model.LightsOp
import ro.vatra.core.model.Me
import ro.vatra.core.model.NotifyOp
import ro.vatra.core.model.NutritionToday
import ro.vatra.core.model.Ok
import ro.vatra.core.model.Water
import ro.vatra.core.model.WaterAct

/**
 * The hub's own contract fixtures (docs/api/fixtures, validated against the zod schemas by
 * src/lib/api/openapi.test.ts) must decode into the app's models, and the app's requests must
 * encode to exactly the fixture requests. Both sides test against the same files.
 */
class ContractTest {
    private val dir = java.io.File(System.getProperty("vatra.fixtures") ?: "../../../docs/api/fixtures")

    private fun fixture(id: String): JsonObject = Json.parseToJsonElement(java.io.File(dir, "$id.json").readText()).jsonObject

    private fun <T> response(id: String, s: KSerializer<T>): T = WireJson.decodeFromJsonElement(s, fixture(id)["response"]!!)

    private fun request(id: String): JsonElement = fixture(id)["request"]!!

    @Test fun everyFixtureHasAModel() {
        val ids = dir.listFiles()!!.map { it.nameWithoutExtension }.sorted()
        assertEquals(DECODERS.keys.sorted(), ids)
    }

    @Test fun responsesDecode() {
        for ((id, s) in DECODERS) response(id, s)
        val me = response("me", Me.serializer())
        assertEquals("child", me.member.role)
        assertFalse(me.can.openDoor)
        val st = response("state", HomeState.serializer())
        assertTrue(st.rooms.single().canControl)
        assertEquals("on", st.states["light.bed_lamp"]?.state)
        assertEquals(1280.0, response("nutritionToday", NutritionToday.serializer()).remaining.calories, 0.0)
        val relay = response("push", ro.vatra.core.model.PushConfig.serializer()).relay
        assertEquals("mfrggzdfmztwq2lk", relay?.hub)
        assertTrue(relay?.usable == true)
        assertEquals(32, ro.vatra.core.push.PushCrypto.decodeKey(response("pushRegister", ro.vatra.core.model.RelayRegistered.serializer()).e2eKey).size)
        assertEquals("open", response("pushCard", ro.vatra.core.model.Card.serializer()).actions.single().id)
    }

    @Test fun requestsEncodeLikeTheFixtures() {
        assertEquals(request("control"), ControlJson.encodeToJsonElement(Control.serializer(), Control.SetLight("light.bed_lamp", brightnessPct = 40, kelvin = 2700)))
        assertEquals(
            request("lightsSet"),
            OpJson.encodeToJsonElement(LightsOp.serializer(), LightsOp.Set("room:bedroom", ro.vatra.core.model.LightState(on = true, rgb = listOf(255, 140, 60), brightnessPct = 50))),
        )
        assertEquals(request("notifyAct"), OpJson.encodeToJsonElement(NotifyOp.serializer(), NotifyOp.Read(listOf("c1"))))
        assertEquals(request("intercomAct"), WireJson.encodeToJsonElement(IntercomAct.serializer(), IntercomAct("arm", 30)))
        assertEquals(request("waterAct"), WireJson.encodeToJsonElement(WaterAct.serializer(), WaterAct("drink", 250)))
        assertEquals(request("presence"), WireJson.encodeToJsonElement(ro.vatra.core.model.PresenceReport.serializer(), ro.vatra.core.model.PresenceReport("home", "geofence")))
        assertEquals(
            request("pushRegister"),
            ro.vatra.core.net.HubClient.relayRegistration("apns", "h1.Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0", null),
        )
        val unified = KindJson.encodeToJsonElement(
            ro.vatra.core.model.PushRegistration.serializer(),
            ro.vatra.core.model.PushRegistration.UnifiedPush("https://ntfy.sh/up1?up=1", "p256", "auth"),
        ).jsonObject
        assertEquals("unifiedpush", (unified["kind"] as kotlinx.serialization.json.JsonPrimitive).content)
    }

    @Test fun unknownFieldsAreIgnored() {
        val w = WireJson.decodeFromString(Water.serializer(), """{"ml":1,"target":2,"glasses":0,"underPace":false,"lastAt":null,"future":{"x":1}}""")
        assertEquals(1, w.ml)
    }

    private companion object {
        val DECODERS: Map<String, KSerializer<*>> = mapOf(
            "me" to Me.serializer(),
            "state" to HomeState.serializer(),
            "control" to Ok.serializer(),
            "lights" to Lights.serializer(),
            "lightsSet" to Applied.serializer(),
            "notifyList" to Cards.serializer(),
            "notifyAct" to Ok.serializer(),
            "intercom" to Intercom.serializer(),
            "intercomAct" to Intercom.serializer(),
            "water" to Water.serializer(),
            "waterAct" to Water.serializer(),
            "nutritionToday" to NutritionToday.serializer(),
            "push" to ro.vatra.core.model.PushConfig.serializer(),
            "pushRegister" to ro.vatra.core.model.RelayRegistered.serializer(),
            "pushCard" to ro.vatra.core.model.Card.serializer(),
            "presence" to ro.vatra.core.model.PresenceResult.serializer(),
        )
    }
}
