// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import android.content.Context
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.player.ItemInfo
import app.friendflix.android.player.PlaybackReporter
import app.friendflix.android.player.PlayerApi
import app.friendflix.android.player.Segment
import app.friendflix.android.settings.AppSettings
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions
import org.json.JSONObject
import java.io.IOException

/**
 * The cast endpoints through [ServerApi] (origin-only session cookie, `x-ff-profile`, CSRF), the same ones the web sender uses.
 * Blocking; URLs, bodies and tokens are never logged.
 */
class CastServerApi(private val server: ServerApi, private val profileId: String, private val player: PlayerApi) : CastServer {
    override fun session(body: JSONObject): TokenAnswer = try {
        val (code, j) = server.sendJson("/api/cast/session", profileId, body) ?: return TokenAnswer.Failed
        when {
            code == 200 && j != null -> CastInfo.parse(j)?.let { TokenAnswer.Ok(it) } ?: TokenAnswer.Failed
            code == 429 && j?.optString("error") == "max_streams" -> TokenAnswer.MaxStreams(j.optInt("max", 1))
            code == 403 && j?.optString("error") == "transcoding_disabled" -> TokenAnswer.NeedsTranscode
            code == 403 && j?.optString("error") == "device_pending" -> TokenAnswer.DevicePending
            // the queued successor is pinned to the playing token's TV address at mint: the TV has not fetched that one yet
            code == 409 && j?.optString("error") == "cast_unpinned" -> TokenAnswer.Unpinned
            else -> TokenAnswer.Failed
        }
    } catch (_: IOException) {
        TokenAnswer.Failed
    }

    override fun revoke(castId: String) {
        if (!CastIds.valid(castId)) return
        try { server.sendJson("/api/cast/session/$castId", profileId, JSONObject(), method = "DELETE") } catch (_: IOException) { }
    }

    /** null: not ours (404 / 400, or an AirPlay token); an [IOException] (network, 5xx, 401): unknown, nothing is concluded */
    override fun lookup(castId: String): CastLookup? {
        if (!CastIds.valid(castId)) return null
        val (code, j) = server.getJson("/api/cast/session/$castId", profileId)
        return when {
            code == 200 && j != null -> CastLookup.parse(j)?.takeIf { it.via != "airplay" }
            code == 404 || code == 400 -> null
            else -> throw IOException("lookup answered $code")
        }
    }

    /**
     * `POST /api/livetv/channels/:id/watch { via: 'chromecast' }` with the shell's session; the answer's relative URL is made absolute
     * against the server origin ([ServerApi.resolve]). Null on every refusal (503 live_full / provider_limit, 502, 409, 429, 403, 404),
     * on a malformed answer and on network trouble: the caller only learns "no". Nothing of the answer is logged.
     */
    override fun watchLive(channelId: String): LiveCastInfo? {
        if (!LIVE_CHANNEL.matches(channelId)) return null
        return try {
            val (code, j) = server.sendJson("/api/livetv/channels/$channelId/watch", profileId, JSONObject().put("via", VIA)) ?: return null
            if (code == 200 && j != null) LiveCastInfo.parse(j) { path -> server.resolve(path)?.toString() } else null
        } catch (_: IOException) {
            null
        }
    }

    /** `DELETE /api/livetv/watch { token }`: the live token is revoked (best effort) */
    override fun stopLive(token: String) {
        try { server.sendJson("/api/livetv/watch", profileId, JSONObject().put("token", token), method = "DELETE") } catch (_: IOException) { }
    }

    override fun report(kind: PlaybackReporter.Kind, body: JSONObject) = player.report(kind, body)

    override fun next(itemId: String): ItemInfo? = try { player.next(itemId) } catch (_: IOException) { null }

    override fun segments(itemId: String): List<Segment> = try {
        val types = player.segmentTypes()
        player.segments(itemId).filter { it.type in types }
    } catch (_: IOException) {
        emptyList()
    }

    companion object {
        /** the bridge's id shape (`ID_PATTERN`: letters, digits, `-`; no `_`, backend channel ids are GUIDs), checked again before it becomes part of a path */
        private val LIVE_CHANNEL = Regex("^[A-Za-z0-9-]{1,64}$")
        private const val VIA = "chromecast"

        /** `GET /api/cast/config` (null: not answered); blocking */
        fun config(server: ServerApi, profileId: String): CastConfig.Config? = try {
            val (code, j) = server.getJson("/api/cast/config", profileId)
            if (code == 200) CastConfig.parse(j) else null
        } catch (_: IOException) {
            null
        }
    }
}

/**
 * The Cast framework's options (manifest `OPTIONS_PROVIDER_CLASS_NAME`), read once per process: the receiver is the server's
 * CAST_RECEIVER_APP_ID as cached in [AppSettings] by the last `/api/cast/config` answer (FriendFlix's own receiver), else the Default
 * Media Receiver (read from the synchronous mirror [AppSettings.castReceiverAppIdNow]). A changed id takes effect after the app restarts.
 */
class CastOptionsProvider : OptionsProvider {
    override fun getCastOptions(context: Context): CastOptions {
        // a plain SharedPreferences read (the mirror AppSettings writes): no blocking DataStore read on the framework's start
        val cached = AppSettings.castReceiverAppIdNow(context)
        return CastOptions.Builder()
            .setReceiverApplicationId(CastConfig.receiverAppId(cached))
            .setStopReceiverApplicationWhenEndingSession(true)
            // the Cast notification / lock screen controls bring the player screen back (it is the remote)
            .setCastMediaOptions(CastMediaOptions.Builder().setExpandedControllerActivityClassName(PLAYER).build())
            .build()
    }

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null

    private companion object {
        const val PLAYER = "app.friendflix.android.player.PlayerActivity"
    }
}
