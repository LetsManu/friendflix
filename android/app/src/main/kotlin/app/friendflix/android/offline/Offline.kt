// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.annotation.VisibleForTesting
import app.friendflix.android.bridge.MAX_START_MS
import app.friendflix.android.bridge.NoPlayerLauncher
import app.friendflix.android.bridge.OfflineMedia
import app.friendflix.android.bridge.PlayRequest
import app.friendflix.android.bridge.PlayerLauncher
import app.friendflix.android.downloads.Downloads
import kotlinx.coroutines.launch
import java.io.File

sealed interface PlayResult {
    /** the player took it */
    data object Started : PlayResult
    /** the player declined (until Task 8 the app's launcher is a stub that always declines) */
    data object Declined : PlayResult
    data class Blocked(val reason: PlayBlock) : PlayResult
}

/**
 * The offline side of native downloads, wired once per process ([get]; tests [install] their own): licence checks ([checker]), the
 * position / watched queue ([sync]) and playback from the offline list through [launcher].
 *
 * API for Task 8 (player): set [launcher]; report positions with [recordPosition]. Task 11 (menu / notification): open the list with
 * [OfflineActivity.intent].
 */
class Offline(val downloads: Downloads, dir: File, private val now: () -> Long = System::currentTimeMillis) {
    val state = OfflineState(File(dir, "offline-state.json"))
    val sync = SyncQueue(File(dir, "sync-queue.json"))
    val checker = LicenseChecker(downloads, state, sync, now)
    /** Plays an [OfflineMedia] request. Task 8 sets the real player; until then the stub declines and the list says so. */
    @Volatile var launcher: PlayerLauncher = NoPlayerLauncher

    /** The web UI handed over a play or download for [profileId]: that profile is the active one. */
    fun noteProfile(profileId: String) = state.setProfile(profileId)

    /** Plays a download from the offline list: checks the licence rules again, then hands the local files to [launcher]. */
    fun play(licenseId: String): PlayResult {
        val r = downloads.store.get(licenseId) ?: return PlayResult.Blocked(PlayBlock.NOT_DONE)
        checker.verdict(r)?.let { return PlayResult.Blocked(it) }
        checker.touch()
        val dir = downloads.queue.dirOf(r) ?: return PlayResult.Blocked(PlayBlock.STORAGE_UNAVAILABLE)
        val video = File(dir, r.file)
        if (!video.isFile) return PlayResult.Blocked(PlayBlock.FILE_MISSING)
        val subs = r.subtitles.map { it.lang to File(dir, it.file) }.filter { it.second.isFile }
        val start = r.positionMs.takeIf { it > 0 }?.coerceAtMost(MAX_START_MS)
        val req = PlayRequest(r.itemId, r.profileId, start, null, null, null, OfflineMedia(licenseId, video, subs))
        return if (launcher.launch(req)) PlayResult.Started else PlayResult.Declined
    }

    /**
     * Task 8: the offline player reached [positionMs] (or finished: [played]). Stored on the download (the list resumes there) and
     * queued for the server, sent on the next start / reconnect.
     */
    fun recordPosition(licenseId: String, positionMs: Long, played: Boolean) {
        val pos = positionMs.coerceAtLeast(0)
        val r = downloads.store.update(licenseId) { it.copy(positionMs = if (played) 0 else pos) } ?: return
        sync.add(SyncEvent(licenseId, r.itemId, r.profileId, pos * TICKS_PER_MS, played, now()))
        checker.touch()
    }

    /** App start (shell): keys, online check, position sync, in the background. */
    fun startInBackground() {
        downloads.scope.launch { checker.start() }
    }

    /** The network came back. */
    fun reconnectInBackground() {
        downloads.scope.launch { checker.onReconnect() }
    }

    companion object {
        private const val TICKS_PER_MS = 10_000L

        @SuppressLint("StaticFieldLeak") // holds the application context only (through Downloads)
        @Volatile private var instance: Offline? = null

        fun get(context: Context): Offline = instance ?: synchronized(this) {
            instance ?: Offline(Downloads.get(context), context.applicationContext.filesDir).also { instance = it }
        }

        @VisibleForTesting
        fun install(o: Offline?) { instance = o }
    }
}

/** Calls [onAvailable] when a network becomes usable, while started (an activity's onStart / onStop). */
class NetworkWatch(context: Context, private val onAvailable: () -> Unit) {
    private val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null

    fun start() {
        if (callback != null || cm == null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onAvailable()
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            callback = cb
        } catch (_: RuntimeException) {
            // too many callbacks / no permission: reconnects are then noticed on the next start only
        }
    }

    fun stop() {
        val cb = callback ?: return
        callback = null
        try { cm?.unregisterNetworkCallback(cb) } catch (_: IllegalArgumentException) { }
    }
}
