package ro.vatra.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient

class AccountDeleteTest {
    private lateinit var server: MockWebServer

    @Before fun up() {
        server = MockWebServer()
        server.start()
    }

    @After fun down() = runCatching { server.shutdown() }.let { }

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    private fun client() = HubClient(server.url("/").toString(), "vmd_secret", language = "ro")

    @Test fun postsThePasswordWithTheDeviceTokenInTheHeader() = runTest {
        server.enqueue(json("""{"ok":true}"""))
        val r = client().deleteAccount("p@ss \"word\"")
        assertTrue(r is ApiResult.Ok && r.value.ok)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/v1/app/account/delete", req.requestUrl!!.encodedPath)
        assertEquals(null, req.requestUrl!!.query)
        assertEquals("Bearer vmd_secret", req.getHeader("Authorization"))
        assertEquals("ro", req.getHeader("Accept-Language"))
        assertTrue(req.getHeader("Content-Type")!!.startsWith("application/json"))
        val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(setOf("password"), body.keys)
        assertEquals("p@ss \"word\"", body["password"]!!.jsonPrimitive.content)
    }

    @Test fun ownerRefusalKeepsTheCodeAndTheLocalisedText() = runTest {
        server.enqueue(json("""{"ok":false,"code":"owner_cannot_delete","error":"Proprietarul șterge casa resetând hubul."}""", 409))
        val r = client().deleteAccount("x")
        assertEquals(ApiResult.Refused(409, "owner_cannot_delete", "Proprietarul șterge casa resetând hubul."), r)
    }

    @Test fun wrongPasswordIsARefusalNotOffline() = runTest {
        server.enqueue(json("""{"ok":false,"code":"wrong_password","error":"Wrong password."}""", 403))
        val r = client().deleteAccount("x") as ApiResult.Refused
        assertEquals(403, r.status)
        assertEquals("wrong_password", r.code)
    }
}