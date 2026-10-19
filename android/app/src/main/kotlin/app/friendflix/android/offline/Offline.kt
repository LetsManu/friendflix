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
import app.friendflix.android.bridge.PlayRequest
import app.friendflix.android.bridge.PlayerLauncher
import app.friendflix.android.downloads.Downloads
import kotlinx.coroutines.launch
import java.io.File

sealed interface PlayResult {
    /** the player took it */
    data object Started : PlayResult
    /** the player declined */
    data object Declined : PlayResult
    data class Blocked(val reason: PlayBlock) : PlayResult
}

/** The offline gate's answer: a request carrying a fresh [OfflineMedia], or why the download cannot be played now. */
sealed interface Prepared {
    class Ready(val request: PlayRequest) : Prepared
    data class Blocked(val reason: PlayBlock) : Prepared
}

/**
 * The offline side of native downloads, wired once per process ([get]; tests [install] their own): licence checks ([checker]), the
 * position / watched queue ([sync]) and playback from the offline list through [launcher].
 *
 * API for the player (Task 8): [launcher] is the native player; positions go to [recordPosition]; a restored player (process death,
 * recreation) asks [prepare] again with the licence id it kept and plays only the [OfflineMedia] it gets back. Task 11 (menu /
 * notification): open the list with [OfflineActivity.intent].
 */
class Offline(val downloads: Downloads, dir: File, private val now: () -> Long = System::currentTimeMillis) {
    val state = OfflineState(File(dir, "offline-state.json"))
    val sync = SyncQueue(File(dir, "sync-queue.json"))
    val checker = LicenseChecker(downloads, state, sync, now)
    /** The native player (set by the shell); the stub declines. */
    @Volatile var launcher: PlayerLauncher = NoPlayerLauncher

    /** The web UI handed over a play or download for [profileId]: that profile is the active one. */
    fun noteProfile(profileId: String) = state.setProfile(profileId)

    /**
     * The offline gate, and the only place an [OfflineMedia] is made: opens the download keys first when they are not open yet (a
     * Keystore that cannot give them blocks, it never passes), then checks the licence rules ([LicenseChecker.verdict]), the storage
     * card and the file. Used by [play] and by the player when it is restored.
     */
    suspend fun prepare(licenseId: String): Prepared {
        if (checker.keysAvailable.value != true) checker.openKeys()
        val r = downloads.store.get(licenseId) ?: return Prepared.Blocked(PlayBlock.NOT_DONE)
        checker.verdict(r)?.let { return Prepared.Blocked(it) }
        checker.touch()
        val dir = downloads.queue.dirOf(r) ?: return Prepared.Blocked(PlayBlock.STORAGE_UNAVAILABLE)
        val video = File(dir, r.file)
        if (!video.isFile) return Prepared.Blocked(PlayBlock.FILE_MISSING)
        val subs = r.subtitles.map { it.lang to File(dir, it.file) }.filter { it.second.isFile }
        val start = r.positionMs.takeIf { it > 0 }?.coerceAtMost(MAX_START_MS)
        return Prepared.Ready(PlayRequest(r.itemId, r.profileId, start, null, null, null, OfflineMedia(licenseId, video, subs, Passed)))
    }

    /** Plays a download from the offline list: [prepare], then hands the local files to [launcher]. */
    suspend fun play(licenseId: String): PlayResult = when (val p = prepare(licenseId)) {
        is Prepared.Blocked -> PlayResult.Blocked(p.reason)
        is Prepared.Ready -> if (launcher.launch(p.request)) PlayResult.Started else PlayResult.Declined
    }

    /** The verdict passed: the one value that can build an [OfflineMedia]. */
    private data object Passed : OfflineVerdict()

    /**
     * The offline player reached [positionMs] (or finished: [played]). Stored on the download (the list resumes there) and
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
