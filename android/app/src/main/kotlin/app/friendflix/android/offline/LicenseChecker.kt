// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import android.util.Log
import app.friendflix.android.crypto.KeysUnavailableException
import app.friendflix.android.downloads.DownloadRecord
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.downloads.Downloads
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.SessionExpired
import app.friendflix.android.setup.ProbeResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException

/** Why a download cannot be played right now (null from [LicenseChecker.verdict] = it can). */
enum class PlayBlock {
    /** not fully downloaded */
    NOT_DONE,
    /** revoked, or past its licence expiry */
    EXPIRED,
    /** offline longer than the server's offline window since the last good check: go online once */
    CHECK_IN,
    /** the device clock is earlier than a time the app already saw: go online once */
    CLOCK,
    /** the download keys cannot be opened right now (Keystore trouble); nothing was deleted */
    KEYS_UNAVAILABLE,
    /** the storage card holding it is not mounted */
    STORAGE_UNAVAILABLE,
    /** the file is not on disk (removed outside the app) */
    FILE_MISSING,
}

sealed interface CheckOutcome {
    /** The server answered: [valid] licences renewed, [revoked] ones deleted on this device. */
    data class Checked(val valid: Int, val revoked: List<String>) : CheckOutcome
    /** The active profile has no licence to check. */
    data object NothingToCheck : CheckOutcome
    /** 401: nothing deleted; the next start or reconnect asks again. */
    data object SignedOut : CheckOutcome
    /** No network: nothing deleted; the offline window keeps counting from the last good check. */
    data object Offline : CheckOutcome
    /** No server configured, no active profile, or the server could not answer (non-200): nothing deleted. */
    data object Wait : CheckOutcome
}

/** When the offline list opens by itself: the server cannot be used right now and there is something to watch. */
object OfflineGate {
    fun shouldOpen(probe: ProbeResult, hasDownloads: Boolean): Boolean =
        hasDownloads && probe !is ProbeResult.Ok && probe != ProbeResult.AppTooOld && probe != ProbeResult.ServerTooOld
}

/**
 * Licence rules for native downloads, mirroring the web client (`web/src/lib/offline/manager.ts` checkIn, `license.ts` isPlayable)
 * and docs/downloads.md §5:
 * - Online check at app start and on reconnect: `POST /api/downloads/check` with every non-expired licence of the active profile.
 *   Renewed ones get the server's new `expiresAt` / `validUntil`; revoked ones (device removed, role changed, admin, expired, unknown)
 *   are deleted on this device via [app.friendflix.android.downloads.DownloadQueue.revoke] (files gone, row kept as `expired`, as the
 *   web does; the server already revoked them, so no DELETE). 401, network errors and any other answer delete nothing.
 * - Offline window: the licence's `validUntil` from the server (its `DOWNLOAD_OFFLINE_GRACE_DAYS` after the last check, capped by
 *   `expiresAt`); without one, [DEFAULT_GRACE_MS] after the record's last check. Past it, playback needs an online check first.
 *   Nothing is deleted while offline.
 * - Clock guard: a device time more than [CLOCK_TOLERANCE_MS] before the last good check (or the latest time the app has seen) refuses
 *   playback until the next successful online check.
 * - Keys (Task 5): [openKeys] opens the download keys; lost keys remove the old downloads inside the key source
 *   ([app.friendflix.android.downloads.DownloadQueue.dropUnreadable]); a Keystore that cannot give keys right now deletes nothing and
 *   makes the list show downloads as unavailable.
 */
class LicenseChecker(
    private val d: Downloads,
    private val state: OfflineState,
    private val sync: SyncQueue,
    private val now: () -> Long,
) {
    private val keys = MutableStateFlow<Boolean?>(null)
    /** null = not tried yet, true = the download keys are open, false = the Keystore cannot give them right now. */
    val keysAvailable: StateFlow<Boolean?> = keys.asStateFlow()
    private val checking = Mutex()
    @Volatile private var lastAttempt: Long? = null

    /** App start: remember the time, open the keys (removing unreadable downloads), check online, then send queued positions. */
    suspend fun start() {
        lastAttempt = now()
        touch()
        openKeys()
        online()
    }

    /** The network came back: the same online work as [start], at most once per [RECONNECT_THROTTLE_MS]. */
    suspend fun onReconnect() {
        val t = now()
        val go = synchronized(this) {
            val last = lastAttempt
            (last == null || t - last !in 0 until RECONNECT_THROTTLE_MS).also { if (it) lastAttempt = t }
        }
        if (go) online()
    }

    /** Opens the download keys (off the main thread); false while the Keystore cannot give them. Never deletes anything itself. */
    suspend fun openKeys(): Boolean = withContext(Dispatchers.IO) {
        val ok = try {
            d.keys.keys()
            true
        } catch (_: KeysUnavailableException) {
            Log.w(TAG, "download keys unavailable")
            false
        }
        keys.value = ok
        ok
    }

    /** The app is in use now (offline list, playback): feeds the clock guard. */
    fun touch() = state.bump(now())

    /** One online licence check of the active profile (see the class comment). */
    suspend fun check(): CheckOutcome = checking.withLock {
        withContext(Dispatchers.IO) {
            lastAttempt = now()
            val api = d.api() ?: return@withContext CheckOutcome.Wait
            try {
                doCheck(api)
            } catch (_: SessionExpired) {
                Log.i(TAG, "licence check: signed out")
                CheckOutcome.SignedOut
            } catch (e: IOException) {
                Log.i(TAG, "licence check: offline (${e.javaClass.simpleName})")
                CheckOutcome.Offline
            }
        }
    }

    private fun doCheck(api: ServerApi): CheckOutcome {
        val me = api.me() ?: return CheckOutcome.Wait
        val profile = me.profileId ?: return CheckOutcome.Wait
        state.setProfile(profile, me.kids)
        val ids = d.store.all().filter { it.profileId == profile && it.state != DownloadState.EXPIRED }.map { it.licenseId }
        if (ids.isEmpty()) return CheckOutcome.NothingToCheck
        var valid = 0
        val revoked = mutableListOf<String>()
        for (part in ids.chunked(ServerApi.MAX_IDS)) {
            val r = api.checkAll(part, profile) ?: return CheckOutcome.Wait
            val t = now()
            for (v in r.valid) {
                if (v.id !in part) continue
                d.store.update(v.id) { it.copy(expiresAt = v.expiresAt, validUntil = v.validUntil, lastCheck = t) }
                valid++
            }
            for (id in r.revoked) {
                val rec = d.store.get(id) ?: continue
                if (id !in part || rec.profileId != profile) continue
                d.queue.revoke(id)
                revoked += id
            }
        }
        state.checkedAt(now())
        if (revoked.isNotEmpty()) Log.i(TAG, "licence check: ${revoked.size} revoked")
        return CheckOutcome.Checked(valid, revoked)
    }

    /** Sends queued positions of the active profile. */
    suspend fun flushSync(): FlushResult {
        val profile = state.lastProfileId ?: return FlushResult.LATER
        val api = d.api() ?: return FlushResult.LATER
        return sync.flush(api, profile)
    }

    private suspend fun online() {
        when (check()) {
            CheckOutcome.SignedOut, CheckOutcome.Offline -> Unit // the progress post would fail the same way
            else -> flushSync()
        }
    }

    /** The profile whose downloads the offline list shows: the last active one; unknown → the only profile that has downloads. */
    fun activeProfile(): String? = state.lastProfileId ?: d.store.all().map { it.profileId }.distinct().singleOrNull()

    /** The active profile's downloads (every state; the list says why one cannot play). */
    fun entries(): List<DownloadRecord> {
        val p = activeProfile() ?: return emptyList()
        return d.store.all().filter { it.profileId == p }
    }

    /** Whether the active profile has a finished download (the offline list is worth opening). */
    fun hasDownloads(): Boolean = entries().any { it.state == DownloadState.DONE }

    /** Null when [r] may be played at [t]; else why not. Pure apart from reading state; deletes nothing. */
    fun verdict(r: DownloadRecord, t: Long = now()): PlayBlock? {
        if (r.state == DownloadState.EXPIRED) return PlayBlock.EXPIRED
        if (r.state != DownloadState.DONE) return PlayBlock.NOT_DONE
        if (keys.value == false) return PlayBlock.KEYS_UNAVAILABLE
        if (d.queue.dirOf(r) == null) return PlayBlock.STORAGE_UNAVAILABLE
        val seen = maxOf(state.maxSeen, state.lastCheck, r.lastCheck)
        if (seen > 0 && t < seen - CLOCK_TOLERANCE_MS) return PlayBlock.CLOCK
        if (t > r.expiresAt) return PlayBlock.EXPIRED
        if (t > window(r)) return PlayBlock.CHECK_IN
        return null
    }

    /** The end of [r]'s offline window: the server's `validUntil`, else [DEFAULT_GRACE_MS] after its last check (capped by expiry). */
    fun window(r: DownloadRecord): Long = if (r.validUntil > 0) r.validUntil else minOf(r.expiresAt, r.lastCheck + DEFAULT_GRACE_MS)

    companion object {
        /** `DOWNLOAD_OFFLINE_GRACE_DAYS` default, used only when a licence carries no `validUntil`. */
        const val DEFAULT_GRACE_MS = 7L * 24 * 60 * 60 * 1000
        /** allowed backwards clock skew before the clock counts as turned back */
        const val CLOCK_TOLERANCE_MS = 5L * 60 * 1000
        /** reconnect events (network flapping) start at most one online check per this interval */
        const val RECONNECT_THROTTLE_MS = 30_000L
        private const val TAG = "FFLicenceCheck"
    }
}
