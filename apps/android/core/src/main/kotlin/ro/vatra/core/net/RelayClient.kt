package ro.vatra.core.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import ro.vatra.core.WireJson
import ro.vatra.core.model.RelayHandle
import ro.vatra.core.model.RelayHandleRequest
import java.io.IOException

/**
 * The Vatra Cloud push relay (`vatra-push`). The app only ever calls `POST /v1/handles`: it turns the
 * platform token into an opaque handle bound to one hub, which the hub stores instead of the token.
 */
class RelayClient(relayUrl: String, private val http: OkHttpClient = HubClient.defaultHttp) {
    private val base = relayUrl.trimEnd('/')

    suspend fun handle(platform: String, token: String, hubId: String): ApiResult<String> {
        val url = "$base/v1/handles".toHttpUrlOrNull() ?: return ApiResult.Offline("bad url")
        val body = WireJson.encodeToString(RelayHandleRequest.serializer(), RelayHandleRequest(platform, token, hubId))
        val req = Request.Builder().url(url)
            .header("Accept", "application/json")
            .post(body.toRequestBody(JSON))
            .build()
        return withContext(Dispatchers.IO) {
            try {
                http.newCall(req).execute().use { res -> HubClient.decode(res, RelayHandle.serializer()) }
                    .map { it.handle }
                    .let { if (it is ApiResult.Ok && it.value.isEmpty()) ApiResult.Offline("empty handle") else it }
            } catch (e: IOException) {
                ApiResult.Offline(e.javaClass.simpleName)
            }
        }
    }

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}
