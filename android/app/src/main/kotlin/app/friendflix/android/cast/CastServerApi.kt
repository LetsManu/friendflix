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
            else -> TokenAnswer.Failed
        }
    } catch (_: IOException) {
        TokenAnswer.Failed
    }

    override fun revoke(castId: String) {
        if (!CAST_ID.matches(castId)) return
        try { server.sendJson("/api/cast/session/$castId", profileId, JSONObject(), method = "DELETE") } catch (_: IOException) { }
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
        private val CAST_ID = Regex("^[0-9a-f]{32}$")

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
