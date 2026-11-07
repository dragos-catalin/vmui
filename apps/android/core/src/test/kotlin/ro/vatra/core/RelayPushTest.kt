package ro.vatra.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import ro.vatra.core.hub.HubList
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.model.PushConfig
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient
import ro.vatra.core.net.RelayClient
import ro.vatra.core.push.PushCrypto
import ro.vatra.core.push.PushPayload
import java.util.Base64

/** Vectors from .copilot-tmp/product/p10-03-push-vector.mjs (node:crypto aes-256-gcm, the hub's algorithm). */
class RelayPushTest {
    private val key = ByteArray(32) { 0x11 }
    private val cardId = "card-123"
    private val fullPlain =
        """{"type":"card","id":"card-123","kind":"intercom","tag":"intercom","title":"Someone is at the door","body":"Front gate, 18:42","subtitle":"","color":"","icon":"","priority":"high","progress":"","actions":"[{\"id\":\"open\",\"label\":\"Open\",\"style\":\"primary\"}]","url":"","sticky":"0","at":"1800000000000"}"""
    private val fullE =
        "IiIiIiIiIiIiIiIibNVzMLCqvWXHXL9OLITF93b379hI4s05NmI72jrDSSEuFsVmcZLbtyAsiF-FNyQXn_DqA_JQQNzdGp6ckAiA31qgPkw48T13yVsUwniEm2OL2INXcM66J3l1uc8exm67-mN_PBs47zd-ps9RBjTxUUN-i9M1A-cMuwFTHDPDNqsx-pSW7W1NUSZiIPnbLAFwZ3cv3bjQESFl9govSSgWLzdSK3Ux3UnkgV1Qci-V9h7dYL-AZ6QddspDk42sWuFIxKOjoiBZM2fr6kw1ZpSIXpMPTGFzusUL9WMfwXTvWxkZDbGLvjcNkjfuxF41TyI8UWAOA3J3OSRDUyz9s6J8iriwWZbk95ddU5QPKIaa1iRXBNMYBMCJekY7m91EY156V0l3RMpHVAPxX8l83fWOIpxm2gGwm9yUtk84CVZCggg1aC9d_w"
    private val minimalE =
        "IiIiIiIiIiIiIiIibNVzMLCqvWXHXL9OLITF93b379hI4s05NmI72jrDSSEuFsVmcZLbtyAsiF-FNyQXn_DqA_JQQNzdGp6ckAiA31qgPkw48T13yVsUwniEm2OL2INXcM66J3l1uc8exm67-mN_PAkl4iEu9ZluVmG9TQp-goV8DaZJoQFFHynfJOh0qNDPqTEYQz5sILOcOw10Kj8v1riPPlOGIcJ4ZXinKKECU_Qpog"

    private lateinit var server: MockWebServer

    @Before fun up() {
        server = MockWebServer()
        server.start()
    }

    @After fun down() = runCatching { server.shutdown() }.let { }

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    private val url get() = server.url("/").toString().trimEnd('/')

    private fun assertFails(block: () -> Unit) {
        try {
            block()
        } catch (_: Exception) {
            return
        }
        fail("expected decryption to fail")
    }

    @Test fun opensTheNodeVector() {
        assertEquals(fullPlain, PushCrypto.open(key, cardId, fullE).decodeToString())
    }

    @Test fun keyDecodesFromBase64Url() {
        assertArrayEquals(key, PushCrypto.decodeKey("ERERERERERERERERERERERERERERERERERERERERERE"))
    }

    @Test fun wrongAadFails() {
        assertFails { PushCrypto.open(key, "card-124", fullE) }
    }

    @Test fun wrongKeyFails() {
        assertFails { PushCrypto.open(ByteArray(32) { 0x12 }, cardId, fullE) }
    }

    @Test fun tamperedTagFails() {
        val raw = Base64.getUrlDecoder().decode(fullE)
        raw[raw.size - 1] = (raw[raw.size - 1].toInt() xor 0x01).toByte()
        assertFails { PushCrypto.open(key, cardId, Base64.getUrlEncoder().withoutPadding().encodeToString(raw)) }
    }

    @Test fun tamperedCiphertextFails() {
        val raw = Base64.getUrlDecoder().decode(fullE)
        raw[20] = (raw[20].toInt() xor 0x01).toByte()
        assertFails { PushCrypto.open(key, cardId, Base64.getUrlEncoder().withoutPadding().encodeToString(raw)) }
    }

    @Test fun fromRelayFullCarriesTheCard() {
        val p = PushPayload.fromRelay(mapOf("v" to "1", "id" to cardId, "e" to fullE, "full" to "1", "type" to "card", "kind" to "intercom"), key)!!
        assertEquals("Someone is at the door", p.title)
        assertEquals("Front gate, 18:42", p.body)
        assertEquals("open", p.actions.single().id)
        assertEquals(1_800_000_000_000L, p.at)
        assertTrue(p.isIntercomRing)
        assertFalse(p.needsFetch)
    }

    @Test fun fromRelayMinimalNeedsFetch() {
        val p = PushPayload.fromRelay(mapOf("v" to "1", "id" to cardId, "e" to minimalE, "full" to "0", "type" to "card", "kind" to "intercom"), key)!!
        assertTrue(p.needsFetch)
        assertEquals("Someone is at the door", p.title)
        assertTrue(p.body.isEmpty())
    }

    @Test fun fromRelayMinimalPlaintextAloneSetsNeedsFetch() {
        val p = PushPayload.fromRelay(mapOf("id" to cardId, "e" to minimalE), key)!!
        assertTrue(p.needsFetch)
    }

    @Test fun fromRelayRefusesWrongKeyOrSwappedId() {
        assertNull(PushPayload.fromRelay(mapOf("id" to cardId, "e" to fullE, "full" to "1"), ByteArray(32) { 0x12 }))
        assertNull(PushPayload.fromRelay(mapOf("id" to "card-999", "e" to fullE, "full" to "1"), key))
        assertNull(PushPayload.fromRelay(mapOf("id" to cardId, "e" to "not-base64!!"), key))
        assertNull(PushPayload.fromRelay(mapOf("id" to cardId), key))
    }

    @Test fun pushConfigDecodesRelayTolerantly() {
        val relay = WireJson.decodeFromString(PushConfig.serializer(), """{"fcm":null,"webPush":true,"relay":{"url":"https://push.vatra.example","hub":"abcdefghijklmnop","extra":1}}""").relay
        assertEquals("abcdefghijklmnop", relay?.hub)
        assertTrue(relay?.usable == true)
        assertNull(WireJson.decodeFromString(PushConfig.serializer(), """{"webPush":true,"relay":null}""").relay)
        assertNull(WireJson.decodeFromString(PushConfig.serializer(), """{"webPush":true}""").relay)
        assertFalse(WireJson.decodeFromString(PushConfig.serializer(), """{"relay":{"url":"http://push.lan","hub":"x"}}""").relay!!.usable)
    }

    @Test fun relayHandleRequestShape() = runTest {
        server.enqueue(json("""{"handle":"h1.abc"}"""))
        val r = RelayClient(url).handle("fcm", "fid-1", "abcdefghijklmnop")
        assertEquals(ApiResult.Ok("h1.abc"), r)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/v1/handles", req.path)
        assertNull(req.getHeader("Authorization"))
        val body = WireJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(setOf("platform", "token", "hub"), body.keys)
        assertEquals("fcm", body["platform"]!!.jsonPrimitive.content)
        assertEquals("fid-1", body["token"]!!.jsonPrimitive.content)
        assertEquals("abcdefghijklmnop", body["hub"]!!.jsonPrimitive.content)
    }

    @Test fun relayHandleRateLimitIsARefusal() = runTest {
        server.enqueue(json("""{"error":"rate_limited","retryAfter":60}""", 429))
        assertTrue(RelayClient(url).handle("fcm", "fid-1", "hub") is ApiResult.Refused)
    }

    @Test fun registerRelayHandleSendsKindRelayAndReturnsTheKey() = runTest {
        server.enqueue(json("""{"ok":true,"e2eKey":"ERERERERERERERERERERERERERERERERERERERERERE"}"""))
        val r = HubClient(url, "vmd_t").registerRelayHandle("fcm", "h1.abc")
        assertEquals("ERERERERERERERERERERERERERERERERERERERERERE", (r as ApiResult.Ok).value.e2eKey)
        val req = server.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/v1/app/push", req.path)
        assertEquals("Bearer vmd_t", req.getHeader("Authorization"))
        val body: JsonObject = WireJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("relay", body["kind"]!!.jsonPrimitive.content)
        assertEquals("fcm", body["platform"]!!.jsonPrimitive.content)
        assertEquals("h1.abc", body["handle"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, body["activityHandle"])
    }

    @Test fun pushCardFetchesOneCardById() = runTest {
        server.enqueue(json("""{"id":"card 1/2","kind":"intercom","title":"Door","body":"Front gate","priority":"high","actions":[{"id":"open","label":"Open","style":"primary"}],"createdAt":"2026-11-07T10:00:00Z"}"""))
        val r = HubClient(url, "vmd_t", language = "ro").pushCard("card 1/2")
        val card = (r as ApiResult.Ok).value
        assertEquals("Front gate", card.body)
        assertEquals("open", card.actions.single().id)
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/v1/app/push/card", req.requestUrl!!.encodedPath)
        assertEquals("card 1/2", req.requestUrl!!.queryParameter("id"))
        assertEquals("Bearer vmd_t", req.getHeader("Authorization"))
    }

    @Test fun pushCardRefusalKeepsTheHubCode() = runTest {
        server.enqueue(json("""{"ok":false,"code":"not_found","error":"Nu există"}""", 404))
        val r = HubClient(url, "vmd_t").pushCard("x")
        assertEquals(ApiResult.Refused(404, "not_found", "Nu există"), r)
    }

    @Test fun relayKeyRotatesPerHubAndActiveIsTriedFirst() {
        val a = PairedHub("a", "Home", "http://a", "vmd_a", "a")
        val b = PairedHub("b", "Parents", "http://b", "vmd_b", "b")
        var l = HubList().add(a).add(b).select("b")
        assertTrue(l.relayCandidates().isEmpty())
        l = l.withRelayKey("a", "hubA", "k1").withRelayKey("b", "hubB", "k2")
        assertEquals(listOf("b", "a"), l.relayCandidates().map { it.id })
        l = l.withRelayKey("a", "hubA", "k3")
        assertEquals("k3", l.hubs.first { it.id == "a" }.e2eKey)
        val round = HubList.decode(l.encode())
        assertEquals("hubB", round.hubs.first { it.id == "b" }.relayHubId)
        l = l.withRelayKey("b", "", "")
        assertEquals(listOf("a"), l.relayCandidates().map { it.id })
    }
}
