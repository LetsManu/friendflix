// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.settings

import android.content.Context
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.core.app.NotificationManagerCompat
import app.friendflix.android.crypto.KeystoreKeyProvider
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.downloads.LicenceDeleteWorker
import app.friendflix.android.downloads.OpenOnceKeySource
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.notify.NotificationScheduler
import app.friendflix.android.offline.Offline
import app.friendflix.android.player.PlayerReset
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/** The WebView's side of a sign-out: its cookies (the session) and the page's own storage. */
fun interface WebSession {
    suspend fun clear()
}

/**
 * The real WebView stores. The WebView only ever shows the configured origin and, while signing in, the server's identity provider
 * (every other link opens in the browser), so removing all cookies and all web storage removes that origin's session and data and the
 * WebView's sign-in at the identity provider.
 */
object SystemWebSession : WebSession {
    override suspend fun clear() = withContext(Dispatchers.Main) {
        val cookies = CookieManager.getInstance()
        suspendCancellableCoroutine { c -> cookies.removeAllCookies { c.resume(Unit) } }
        cookies.flush()
        try {
            WebStorage.getInstance().deleteAllData()
        } catch (_: RuntimeException) {
            // no WebView provider (tests): there is no web storage either
        }
    }
}

/**
 * Leaving this device's FriendFlix state behind: "sign out of this device" ([signOut]) and a server address change ([leaveServer]).
 *
 * Both, in this order:
 * 0. every player screen closes ([PlayerReset]), its stop report still sent with the cookie;
 * 1. every WorkManager job is cancelled (downloads, storage moves, licence returns, the notification poll) and waited for; licence
 *    returns that had not run yet are remembered and given back in step 3 (afterwards there is no session for them);
 * 2. the download rows go, and every file in the app's download folders on every mounted volume is deleted;
 * 3. online, best effort, while the session cookie still exists: each licence is given back to the server it came from
 *    (`DELETE /api/downloads/:id`; one the server refuses stays there until it runs out), then the session is ended there
 *    (`POST /auth/logout`). A network failure, 401 or the [budgetMs] ends this step: an unreachable server simply keeps the
 *    licences until they run out;
 * 4. the queued offline positions, the offline state (profile, last check, clock guard) and the notification poller's last seen id;
 * 5. the WebView's cookies and web storage;
 * 6. the notification poll is scheduled again (it does nothing until someone signs in).
 *
 * [signOut] also deletes the download keys (Keystore alias + wrapped blob; the next download creates new ones) and keeps the server
 * address. [leaveServer] keeps the keys (they belong to the device, not the server), forgets what the app learned about the old
 * server and clears the saved address, so the next start runs setup for the new one.
 */
class DeviceReset(
    private val context: Context,
    private val offline: Offline,
    private val web: WebSession = SystemWebSession,
    private val wipeKeys: () -> Unit = { KeystoreKeyProvider.wipe(context) },
    private val budgetMs: Long = BUDGET_MS,
    private val now: () -> Long = System::currentTimeMillis,
    /** closes every player (stop reports still with the cookie) before anything is cleared */
    private val stopPlayback: suspend () -> Unit = { PlayerReset.stopAll(context) },
) {
    private val d = offline.downloads

    suspend fun signOut() = withContext(Dispatchers.IO) {
        try {
            leave()
            wipeKeys()
            (d.keys as? OpenOnceKeySource<*>)?.forget()
            d.settings.forgetSession()
        } finally {
            finish() // the session cookie goes whatever else failed
        }
    }

    suspend fun leaveServer() = withContext(Dispatchers.IO) {
        try {
            leave()
            d.settings.forgetServer()
            d.settings.clearServerOrigin()
        } finally {
            finish()
        }
    }

    private suspend fun leave() {
        try {
            stopPlayback()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Log.w(TAG, "stopping playback: ${e.javaClass.simpleName}")
        }
        val wm = d.workManager
        // licence returns the user started (a deleted download) and that have not run yet: given back below with the others
        val queuedReturns = try {
            LicenceDeleteWorker.pending(wm)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Log.w(TAG, "reading queued licence returns: ${e.javaClass.simpleName}")
            emptyList()
        }
        try {
            wm.cancelAllWork().result.get(CANCEL_WAIT_S, TimeUnit.SECONDS)
        } catch (e: Exception) {
            Log.w(TAG, "cancelling work: ${e.javaClass.simpleName}") // the rows are gone next, so a late worker finds nothing to do
        }
        val rows = d.store.clear()
        rows.forEach { d.queue.clearPrep(it.licenseId) }
        deleteAllFiles()
        val held = rows.filter { it.state != DownloadState.EXPIRED }.map { it.licenseId to it.profileId }
        giveBack((held + queuedReturns).distinctBy { it.first })
        d.store.flush()
        deleteAllFiles() // again: a worker that was mid-chunk when it was cancelled may have written once more
        offline.sync.clear()
        offline.sync.flushToDisk()
        offline.state.clear()
        offline.state.flush()
    }

    private suspend fun finish() {
        try {
            web.clear()
        } finally {
            d.notifier.clearSessionExpired()
            NotificationManagerCompat.from(context).cancelAll() // the old account's notices must not stay in the shade
            NotificationScheduler.schedule(context, d.workManager)
        }
    }

    /** Everything in our download folders (rows, orphans and partial files alike): after a reset nothing there belongs to anyone. */
    private fun deleteAllFiles() {
        for (kind in StorageLocation.entries) {
            val dir = d.locations.dirIfMounted(kind) ?: continue
            dir.listFiles().orEmpty().forEach(File::delete)
        }
    }

    private suspend fun giveBack(licences: List<Pair<String, String>>) {
        val origin = d.settings.serverOrigin.first() ?: return
        val api = ServerApi(origin, d.http.newBuilder().callTimeout(CALL_TIMEOUT_S, TimeUnit.SECONDS).build(), d.cookies)
        val deadline = now() + budgetMs
        try {
            for ((id, profile) in licences) {
                if (now() > deadline) break
                // null (409 other profile active, 403, 5xx): this licence stays until it runs out; the others are still returned
                api.deleteLicence(id, profile)
            }
            if (now() <= deadline) api.logout()
        } catch (e: IOException) { // unreachable, or SessionExpired: there is no session left to end
            Log.i(TAG, "server not reached while signing out: ${e.javaClass.simpleName}")
        }
    }

    private companion object {
        const val TAG = "FFDeviceReset"
        const val BUDGET_MS = 20_000L
        const val CALL_TIMEOUT_S = 8L
        const val CANCEL_WAIT_S = 10L
    }
}
