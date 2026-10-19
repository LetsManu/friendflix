// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.webkit.CookieManager
import okhttp3.Call
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.concurrent.TimeUnit

/** The server answered 401: the WebView session is gone. Downloads pause until the user signs in again. */
class SessionExpired : IOException("session expired")

/** Where the session cookie comes from: the WebView's cookie store. */
interface CookieSource {
    /** `name=value; name2=value2` for [url], or null. */
    fun get(url: String): String?
    fun set(url: String, cookie: String)
}

/** The WebView's cookies (the session the user signed in with). */
class WebViewCookies : CookieSource {
    override fun get(url: String): String? = CookieManager.getInstance().getCookie(url)
    override fun set(url: String, cookie: String) {
        val m = CookieManager.getInstance()
        m.setCookie(url, cookie)
        m.flush()
    }
}

/** OkHttp cookies for exactly one origin (scheme, host, port): every other host gets none and cannot set any. */
class ServerCookieJar(private val origin: HttpUrl, private val source: CookieSource) : CookieJar {
    private fun same(url: HttpUrl) = url.scheme == origin.scheme && url.host.equals(origin.host, ignoreCase = true) && url.port == origin.port

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        if (!same(url)) return emptyList()
        val header = source.get(url.newBuilder().query(null).fragment(null).build().toString()) ?: return emptyList()
        return header.split(';').mapNotNull { part -> part.trim().takeIf { it.isNotEmpty() }?.let { Cookie.parse(url, it) } }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (!same(url)) return
        val base = url.newBuilder().encodedPath("/").query(null).fragment(null).build().toString()
        cookies.forEach { source.set(base, it.toString()) }
    }
}

/** What the server says about a licence (`GET /api/downloads/:id`, the backend's LicenseView). */
data class Licence(
    val id: String,
    val itemId: String,
    /** pending | fetched | deleted | revoked */
    val status: String,
    /** queued | preparing | ready | failed */
    val prepStatus: String,
    val prepPercent: Int,
    val fileUrl: String,
    val bytes: Long?,
    val subtitles: List<Pair<String, String>>,
    val poster: String?,
    val backdrop: String?,
    val title: String,
    val expiresAt: Long,
    /** the offline window the server grants (`validUntil`, epoch ms); 0 when the server did not send one */
    val validUntil: Long = 0,
) {
    val active get() = status == "pending" || status == "fetched"
}

sealed interface LicenceAnswer {
    data class Found(val licence: Licence) : LicenceAnswer
    /** The server does not know this licence for this user, device and profile (deleted, or another device's). */
    data object Gone : LicenceAnswer
    /** Cannot tell now (other profile active, device not approved, downloads switched off, server trouble): try later. */
    data object Wait : LicenceAnswer
}

enum class CheckAnswer { Valid, Revoked, Wait }

/** `/api/me` as the offline code needs it: the active profile of the WebView session (null before one is picked). */
data class Me(val profileId: String?)

/** One licence the check renewed: its hard expiry and the new offline window, both epoch ms. */
data class Renewed(val id: String, val expiresAt: Long, val validUntil: Long)

/** The answer of `POST /api/downloads/check` for a list of ids. */
data class CheckResult(val valid: List<Renewed>, val revoked: List<String>)

/** The answer of `POST /api/downloads/progress`. */
sealed interface ProgressAnswer {
    /** Taken: [skipped] items were not written because the server's own state is newer (or the licence is gone). */
    data class Taken(val applied: List<String>, val skipped: List<String>) : ProgressAnswer
    /** The server will never take these events (bad request, downloads switched off): drop them. */
    data object Rejected : ProgressAnswer
    /** Try again later (server trouble, another profile active, rate limit). */
    data object Later : ProgressAnswer
}

/**
 * The FriendFlix API as the downloader needs it, authenticated only by the WebView's session cookie for [origin].
 * Every call: 401 → [SessionExpired]; network trouble → IOException. API calls send `x-ff-profile` (the licence's profile): the server
 * answers 409 when another profile is active, which is [LicenceAnswer.Wait], never a revocation. Redirects are not followed.
 */
class ServerApi(val origin: HttpUrl, base: OkHttpClient, cookies: CookieSource) {
    /**
     * The origin-only cookie client (session cookie for [origin] only, no redirects). The player streams through it
     * (media3-datasource-okhttp): the gateway's stream URLs are same-origin, and no other host ever gets the cookie.
     */
    val client: OkHttpClient = base.newBuilder()
        .cookieJar(ServerCookieJar(origin, cookies))
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
        .build()
    @Volatile private var csrf: String? = null

    /** A same-origin absolute path from the server (`/media/...`) as a URL; anything else (other host, relative, `//host`) is null. */
    fun resolve(path: String): HttpUrl? {
        if (!path.startsWith("/") || path.startsWith("//") || path.contains('\\')) return null
        val u = origin.resolve(path) ?: return null
        return u.takeIf { it.scheme == origin.scheme && it.host == origin.host && it.port == origin.port }
    }

    fun licence(id: String, profileId: String): LicenceAnswer {
        val url = origin.newBuilder().addPathSegments("api/downloads").addPathSegment(id).build()
        client.newCall(api(url, profileId).get().build()).execute().use { r ->
            if (r.code == 401) throw SessionExpired()
            val body = bodyJson(r)
            if (r.code == 404) return if (body?.optString("error") == "not_found") LicenceAnswer.Gone else LicenceAnswer.Wait
            if (r.code != 200 || body == null) return LicenceAnswer.Wait
            return parseLicence(body)?.let { LicenceAnswer.Found(it) } ?: LicenceAnswer.Wait
        }
    }

    /** `POST /api/downloads/check`: the server's verdict (it also revokes licences the account may no longer hold). */
    fun check(id: String, profileId: String): CheckAnswer {
        val r = checkAll(listOf(id), profileId) ?: return CheckAnswer.Wait
        if (id in r.revoked) return CheckAnswer.Revoked
        if (r.valid.any { it.id == id }) return CheckAnswer.Valid
        return CheckAnswer.Wait
    }

    /**
     * `POST /api/downloads/check` for up to 200 ids of [profileId]: every id comes back renewed or revoked. Null when the server could not
     * answer (any status but 200, or a malformed body): nothing may be concluded from that.
     */
    fun checkAll(ids: List<String>, profileId: String): CheckResult? {
        require(ids.size <= MAX_IDS) { "at most $MAX_IDS ids per check" }
        val url = origin.newBuilder().addPathSegments("api/downloads/check").build()
        val r = post(url, profileId, JSONObject().put("ids", JSONArray(ids))) ?: return null
        val revoked = r.optJSONArray("revoked") ?: return null
        val valid = r.optJSONArray("valid") ?: return null
        return try {
            CheckResult(
                valid = (0 until valid.length()).map { i ->
                    val v = valid.getJSONObject(i)
                    Renewed(v.getString("id"), time(v.get("expiresAt")), time(v.get("validUntil")))
                },
                revoked = (0 until revoked.length()).map { revoked.getString(it) },
            )
        } catch (_: JSONException) {
            null
        } catch (_: DateTimeParseException) {
            null
        }
    }

    /** `GET /api/me`: the session's active profile (and the CSRF token, kept for the next write). */
    fun me(): Me? {
        val url = origin.newBuilder().addPathSegments("api/me").build()
        client.newCall(Request.Builder().url(url).header("accept", "application/json").get().build()).execute().use { r ->
            if (r.code == 401) throw SessionExpired()
            if (r.code != 200) return null
            val j = bodyJson(r) ?: return null
            j.optString("csrfToken").takeIf { it.isNotEmpty() }?.let { csrf = it }
            val p = j.optJSONObject("profile")?.optString("id")?.takeIf { it.isNotEmpty() }
            return Me(p)
        }
    }

    /** `POST /api/downloads/progress` with up to 200 offline watch events (`{downloadId,itemId,positionTicks,played,at}`). */
    fun progress(profileId: String, events: JSONArray): ProgressAnswer {
        val url = origin.newBuilder().addPathSegments("api/downloads/progress").build()
        val (code, j) = postStatus(url, profileId, JSONObject().put("events", events)) ?: return ProgressAnswer.Later
        return when {
            code == 200 -> ProgressAnswer.Taken(strings(j?.optJSONArray("applied")), strings(j?.optJSONArray("skipped")))
            code == 400 || code == 404 -> ProgressAnswer.Rejected
            else -> ProgressAnswer.Later
        }
    }

    /** `POST /api/downloads/:id/fetched`; best effort, true when the server took it. */
    fun markFetched(id: String, profileId: String, bytes: Long): Boolean {
        val url = origin.newBuilder().addPathSegments("api/downloads").addPathSegment(id).addPathSegment("fetched").build()
        return post(url, profileId, JSONObject().put("bytes", bytes)) != null
    }

    /** `DELETE /api/downloads/:id`: true = gone on the server (also when it was already gone), null = try later. */
    fun deleteLicence(id: String, profileId: String): Boolean? {
        val url = origin.newBuilder().addPathSegments("api/downloads").addPathSegment(id).build()
        repeat(2) { attempt ->
            val token = csrfToken() ?: return null
            client.newCall(api(url, profileId).header("x-csrf-token", token).delete().build()).execute().use { r ->
                if (r.code == 401) throw SessionExpired()
                if (r.code == 200) return true
                val body = bodyJson(r)
                if (r.code == 404 && body?.optString("error") == "not_found") return true
                if (r.code == 403 && body?.optString("error") == "csrf" && attempt == 0) { csrf = null; return@repeat }
                return null
            }
        }
        return null
    }

    /** The download file, from [offset] and pinned to [ifRange] when resuming. The caller closes the response. */
    fun file(url: HttpUrl, offset: Long, ifRange: String?): Call {
        val b = Request.Builder().url(url).get().header("accept-encoding", "identity")
        if (offset > 0) {
            b.header("range", "bytes=$offset-")
            if (ifRange != null) b.header("if-range", ifRange)
        }
        return client.newCall(b.build())
    }

    /** A small same-origin resource (subtitle, artwork) of at most [max] bytes, or null when it is not there. */
    fun small(url: HttpUrl, max: Int): ByteArray? {
        client.newCall(Request.Builder().url(url).get().build()).execute().use { r ->
            if (r.code == 401) throw SessionExpired()
            if (r.code != 200) return null
            val body = r.body
            if (body.contentLength() > max) return null
            val src = body.source()
            if (src.request(max.toLong() + 1)) return null // more than max bytes
            return src.readByteArray()
        }
    }

    /** `GET` of a same-origin API path (`/api/...`) for [profileId]: status and JSON body (null when not JSON / too large). */
    fun getJson(path: String, profileId: String): Pair<Int, JSONObject?> {
        val url = resolve(path) ?: throw IOException("not an app path")
        client.newCall(api(url, profileId).get().build()).execute().use { r ->
            if (r.code == 401) throw SessionExpired()
            return r.code to bodyJson(r)
        }
    }

    /** A JSON `POST` / `PUT` of a same-origin API path with the CSRF token: status and body, or null when no token could be had. */
    fun sendJson(path: String, profileId: String, body: JSONObject, method: String = "POST"): Pair<Int, JSONObject?>? {
        val url = resolve(path) ?: throw IOException("not an app path")
        return postStatus(url, profileId, body, method)
    }

    private fun api(url: HttpUrl, profileId: String) = Request.Builder().url(url).header("accept", "application/json").header("x-ff-profile", profileId)

    private fun post(url: HttpUrl, profileId: String, body: JSONObject): JSONObject? =
        postStatus(url, profileId, body)?.let { (code, j) -> if (code == 200) j ?: JSONObject() else null }

    /** A JSON POST with the CSRF token (refetched once on a csrf 403): status and body, or null when no token could be had. */
    private fun postStatus(url: HttpUrl, profileId: String, body: JSONObject, method: String = "POST"): Pair<Int, JSONObject?>? {
        repeat(2) { attempt ->
            val token = csrfToken() ?: return null
            val req = api(url, profileId).header("x-csrf-token", token).method(method, body.toString().toRequestBody(JSON)).build()
            client.newCall(req).execute().use { r ->
                if (r.code == 401) throw SessionExpired()
                val j = bodyJson(r)
                if (r.code == 403 && j?.optString("error") == "csrf" && attempt == 0) { csrf = null; return@repeat }
                return r.code to j
            }
        }
        return null
    }

    private fun strings(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotEmpty() } }

    private fun csrfToken(): String? {
        csrf?.let { return it }
        val url = origin.newBuilder().addPathSegments("api/me").build()
        client.newCall(Request.Builder().url(url).header("accept", "application/json").get().build()).execute().use { r ->
            if (r.code == 401) throw SessionExpired()
            if (r.code != 200) return null
            return bodyJson(r)?.optString("csrfToken")?.takeIf { it.isNotEmpty() }?.also { csrf = it }
        }
    }

    private fun bodyJson(r: Response): JSONObject? = try {
        val s = r.body.source()
        if (!s.request(MAX_JSON + 1)) JSONObject(s.readUtf8()) else null
    } catch (_: JSONException) {
        null
    }

    private fun parseLicence(o: JSONObject): Licence? = try {
        val prep = o.getJSONObject("prep")
        val subs = o.optJSONArray("subtitles") ?: JSONArray()
        Licence(
            id = o.getString("id"),
            itemId = o.getString("itemId"),
            status = o.getString("status"),
            prepStatus = prep.getString("status"),
            prepPercent = prep.optInt("percent").coerceIn(0, 100),
            fileUrl = o.getString("fileUrl"),
            bytes = if (o.isNull("bytes")) null else o.optLong("bytes"),
            subtitles = (0 until subs.length()).mapNotNull { i -> subs.optJSONObject(i)?.let { it.optString("lang") to it.optString("url") } },
            poster = if (o.isNull("poster")) null else o.optString("poster"),
            backdrop = if (o.isNull("backdrop")) null else o.optString("backdrop"),
            title = o.optString("title"),
            expiresAt = time(o.get("expiresAt")),
            validUntil = if (o.has("validUntil") && !o.isNull("validUntil")) time(o.get("validUntil")) else 0,
        )
    } catch (_: JSONException) {
        null
    } catch (_: DateTimeParseException) {
        null
    }

    private fun time(v: Any): Long = when (v) {
        is Number -> v.toLong()
        else -> Instant.parse(v.toString()).toEpochMilli()
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private const val MAX_JSON = 1L shl 20
        /** the server takes at most 200 ids / events per request */
        const val MAX_IDS = 200
    }
}
