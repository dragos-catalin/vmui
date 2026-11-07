package ro.vatra.core

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import ro.vatra.core.hub.HubList
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient
import ro.vatra.core.pairing.PairLink
import ro.vatra.core.pairing.PairState
import ro.vatra.core.pairing.Pairing

class PairingTest {
    private lateinit var server: MockWebServer
    private val discover = """{"app":"vmui","product":"vatra","host":"vatra-ab12","version":"1.0.0","apiVersion":1,"minClient":1,"claimed":true,"pair":"/api/devices/pair"}"""
    private val me = """{"apiVersion":1,"minClient":1,"member":{"displayName":"Ana","role":"adult"},"deviceId":"0123456789abcdef","rooms":{},"can":{"openDoor":true,"manageHome":false}}"""

    @Before fun up() {
        server = MockWebServer()
        server.start()
    }

    @After fun down() = runCatching { server.shutdown() }.let { }

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    private val url get() = server.url("/").toString().trimEnd('/')

    @Test fun linkParsesTheHubInvite() {
        val l = PairLink.parse("vatra://pair?h=http%3A%2F%2F192.168.1.5%3A3737&c=AbCdEfGhIjKlMnOpQrStUv")
        assertEquals(PairLink("http://192.168.1.5:3737", "AbCdEfGhIjKlMnOpQrStUv"), l)
    }

    @Test fun linkRejectsAnythingElse() {
        assertNull(PairLink.parse("https://evil.example/pair?h=x&c=AbCdEfGhIjKlMnOpQrStUv"))
        assertNull(PairLink.parse("vatra://pair?h=http%3A%2F%2Fhub&c=short"))
        assertNull(PairLink.parse("vatra://pair?h=file%3A%2F%2F%2Fetc&c=AbCdEfGhIjKlMnOpQrStUv"))
        assertNull(PairLink.parse("vatra://pair?h=http%3A%2F%2Fu%3Ap%40hub&c=AbCdEfGhIjKlMnOpQrStUv"))
        assertNull(PairLink.parse("vatra://pair?h=http%3A%2F%2Fhub%2Fapi&c=AbCdEfGhIjKlMnOpQrStUv"))
        assertNull(PairLink.parse("not a link"))
    }

    @Test fun bareAddressBecomesAnOrigin() {
        assertEquals("http://vatra.local", PairLink.normaliseHub("vatra.local"))
        assertEquals("https://h.example:8443", PairLink.normaliseHub("https://h.example:8443/"))
    }

    @Test fun inviteIsInstantAndSendsTheTokenOnlyInTheHeader() = runTest {
        server.enqueue(json(discover))
        server.enqueue(json("""{"id":"0123456789abcdef","token":"vmd_secret","status":"approved"}"""))
        server.enqueue(json(me))
        server.enqueue(json(discover))
        val r = Pairing("Pixel", "ro").withInvite(PairLink(url, "AbCdEfGhIjKlMnOpQrStUv"))
        assertTrue(r is PairState.Paired)
        val hub = (r as PairState.Paired).hub
        assertEquals("Ana", hub.memberName)
        assertEquals("vatra-ab12", hub.name)
        server.takeRequest()
        val pair = server.takeRequest()
        val body = pair.body.readUtf8()
        assertTrue(body.contains("\"invite\":\"AbCdEfGhIjKlMnOpQrStUv\""))
        assertTrue(body.contains("\"platform\":\"vatra-android\""))
        assertNull(pair.getHeader("Authorization"))
        val meReq = server.takeRequest()
        assertEquals("Bearer vmd_secret", meReq.getHeader("Authorization"))
        assertTrue(!meReq.requestUrl.toString().contains("vmd_"))
    }

    @Test fun approvalPollsUntilApproved() = runTest {
        server.enqueue(json(discover))
        server.enqueue(json("""{"id":"0123456789abcdef","token":"vmd_x","code":"0420","status":"pending"}"""))
        server.enqueue(json("""{"status":"pending","code":"0420"}"""))
        server.enqueue(json("""{"status":"approved","code":null}"""))
        server.enqueue(json(me))
        server.enqueue(json(discover))
        val seen = mutableListOf<PairState>()
        val r = Pairing("Pixel", "en", pollMs = 1).withApproval(url) { seen += it }
        assertTrue(r is PairState.Paired)
        assertTrue(seen.contains(PairState.AwaitingApproval("0420")))
    }

    @Test fun refusalCarriesTheHubCode() = runTest {
        server.enqueue(json(discover))
        server.enqueue(json("""{"ok":false,"code":"invite_invalid","error":"Invitația a expirat"}""", 401))
        val r = Pairing("Pixel", "ro").withInvite(PairLink(url, "AbCdEfGhIjKlMnOpQrStUv"))
        assertEquals(PairState.Failed("invite_invalid", "Invitația a expirat"), r)
    }

    @Test fun refusesAHubThatNeedsANewerApp() = runTest {
        server.enqueue(json(discover.replace("\"minClient\":1", "\"minClient\":9")))
        val r = Pairing("Pixel", "en").withApproval(url)
        assertEquals(PairState.Failed("too_old"), r)
        assertEquals(1, server.requestCount)
    }

    @Test fun rejectsANonVatraServerBeforeSendingCredentials() = runTest {
        server.enqueue(json("""{"app":"other"}"""))
        val r = Pairing("Pixel", "en").withLogin(url, "a@b.c", "pw")
        assertEquals(PairState.Failed("not_vatra"), r)
        assertEquals(1, server.requestCount)
    }

    @Test fun clientMapsOfflineAndTooOld() = runTest {
        server.enqueue(json(me.replace("\"minClient\":1", "\"minClient\":5")))
        assertEquals(ApiResult.TooOld(5), HubClient(url, "vmd_x").me())
        server.shutdown()
        assertTrue(HubClient(url, "vmd_x").state() is ApiResult.Offline)
    }

    @Test fun hubListAddsSelectsAndRemoves() {
        val a = PairedHub("a", "Home", "http://a", "vmd_a", "a")
        val b = PairedHub("b", "Parents", "http://b", "vmd_b", "b")
        var l = HubList().add(a).add(b)
        assertEquals("b", l.active?.id)
        l = l.select("a")
        assertEquals("a", l.active?.id)
        l = l.add(a.copy(id = "a2", token = "vmd_new"))
        assertEquals(2, l.hubs.size)
        assertEquals("vmd_new", l.active?.token)
        l = l.remove("a2")
        assertEquals("b", l.active?.id)
        assertEquals(l, HubList.decode(l.encode()))
        assertEquals(HubList(), HubList.decode("garbage"))
    }
}
