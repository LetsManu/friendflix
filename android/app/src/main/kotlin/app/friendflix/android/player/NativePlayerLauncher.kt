// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import app.friendflix.android.bridge.PlayRequest
import app.friendflix.android.bridge.PlayerLauncher
import java.util.UUID

/**
 * The real [PlayerLauncher] (Task 8): opens [PlayerActivity] for a bridge / deep-link / offline request.
 *
 * Idempotent per request: the web UI gives a play request 5 s and may send it again after that timeout, so the same request
 * (same item, profile, start, tracks, download) within [RETRY_WINDOW_MS] of the last start, while that player has not closed yet,
 * answers true without opening a second player. Another title, or the same one after its player closed ([ended]), starts normally.
 * Runs on the UI thread (bridge contract); [start] only hands an intent to the system.
 */
class NativePlayerLauncher(
    private val start: (PlayRequest, String) -> Unit,
    private val now: () -> Long = SystemClock::elapsedRealtime,
    /** a repeated request for the open player: bring it to the front (it may be in picture-in-picture or in the background) */
    private val reshow: (PlayRequest, String) -> Unit = { _, _ -> },
) : PlayerLauncher {
    private data class Key(
        val itemId: String, val profileId: String, val startMs: Long?, val mediaSourceId: String?,
        val audio: String?, val subtitle: String?, val licenseId: String?,
    )

    private data class Pending(val key: Key, val token: String, val at: Long)

    private var last: Pending? = null

    @Synchronized
    override fun launch(req: PlayRequest): Boolean {
        val key = Key(req.itemId, req.profileId, req.startMs, req.mediaSourceId, req.audio, req.subtitle, req.offline?.licenseId)
        val t = now()
        val p = last
        if (p != null && p.key == key && t - p.at in 0..RETRY_WINDOW_MS) {
            try { reshow(req, p.token) } catch (e: RuntimeException) { Log.w(TAG, "player could not be shown (${e.javaClass.simpleName})") }
            return true
        }
        val token = UUID.randomUUID().toString()
        return try {
            start(req, token)
            last = Pending(key, token, t)
            true
        } catch (e: RuntimeException) {
            Log.w(TAG, "player could not be opened (${e.javaClass.simpleName})")
            false
        }
    }

    /** The player of [token] closed: the same title may be started again right away. */
    @Synchronized
    fun ended(token: String) {
        if (last?.token == token) last = null
    }

    companion object {
        /** longer than the web UI's 5 s play timeout plus a slow retry */
        const val RETRY_WINDOW_MS = 15_000L
        private const val TAG = "FFPlayer"

        /**
         * The app's launcher (one per process, [Players.launcher]): starts [PlayerActivity]; the request itself (with an offline
         * gate's media) is handed over in memory ([PlayerActivity.Handoff]), the intent carries ids only.
         */
        fun forApp(context: Context): NativePlayerLauncher = Players.launcher ?: synchronized(this) {
            Players.launcher ?: run {
                val app = context.applicationContext
                NativePlayerLauncher(
                    start = { req, token ->
                        PlayerActivity.Handoff.put(token, req)
                        try {
                            app.startActivity(PlayerActivity.intent(app, req, token).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        } catch (e: RuntimeException) {
                            PlayerActivity.Handoff.take(token)
                            throw e
                        }
                    },
                    // same token: the open player ignores it as a new request and simply comes to the front
                    reshow = { req, token -> app.startActivity(PlayerActivity.intent(app, req, token).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) },
                ).also { Players.launcher = it }
            }
        }
    }
}
