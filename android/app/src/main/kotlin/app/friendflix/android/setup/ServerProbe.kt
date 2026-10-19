// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.setup

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

/** The oldest server (release version) this app version works with. */
const val MIN_SERVER = "2.0.0"

data class Semver(val major: Int, val minor: Int, val patch: Int) : Comparable<Semver> {
    override fun compareTo(other: Semver) = compareValuesBy(this, other, Semver::major, Semver::minor, Semver::patch)

    companion object {
        /** Strict major.minor.patch; anything else (pre-release suffixes included) is null. */
        fun parse(text: String): Semver? {
            val p = text.split('.')
            if (p.size != 3) return null
            val n = p.map { s -> if (s.isNotEmpty() && s.all { it in '0'..'9' } && s.length <= 6) s.toInt() else return null }
            return Semver(n[0], n[1], n[2])
        }
    }
}

sealed interface ProbeResult {
    data class Ok(val serverVersion: String) : ProbeResult
    data object NotFriendFlix : ProbeResult
    data object AppTooOld : ProbeResult
    data object ServerTooOld : ProbeResult
    data object TlsProblem : ProbeResult
    data object Unreachable : ProbeResult
}

/** Asks `GET /api/version` (public, no cookies) whether the address is a FriendFlix server this app can talk to. */
class ServerProbe(
    client: OkHttpClient = OkHttpClient(),
    private val appVersion: String,
    private val minServer: String = MIN_SERVER,
) {
    private val client = client.newBuilder()
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS)
        .build()

    suspend fun probe(origin: HttpUrl): ProbeResult = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(origin.newBuilder().encodedPath("/api/version").build()).get().build()
        try {
            client.newCall(request).execute().use { response ->
                if (response.code != 200) return@use ProbeResult.NotFriendFlix
                evaluate(response.peekBody(MAX_BODY).string())
            }
        } catch (_: SSLException) {
            ProbeResult.TlsProblem
        } catch (_: IOException) {
            ProbeResult.Unreachable
        }
    }

    // FriendFlix answers {sha, version, codename, build, channel, label}; minAndroid (added by a later server) is optional.
    private fun evaluate(body: String): ProbeResult {
        val json = try { JSONObject(body) } catch (_: Exception) { return ProbeResult.NotFriendFlix }
        val sha = json.optString("sha", "")
        val version = json.optString("version", "")
        val server = Semver.parse(version)
        if (sha.isEmpty() || json.optString("codename", "").isEmpty() || server == null) return ProbeResult.NotFriendFlix
        val app = Semver.parse(appVersion)
        val minAndroid = Semver.parse(json.optString("minAndroid", ""))
        if (app != null && minAndroid != null && app < minAndroid) return ProbeResult.AppTooOld
        val min = Semver.parse(minServer)
        if (min != null && server < min) return ProbeResult.ServerTooOld
        return ProbeResult.Ok(version)
    }

    private companion object {
        const val MAX_BODY = 64L * 1024
    }
}
