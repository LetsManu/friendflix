// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.workDataOf
import app.friendflix.android.bridge.DownloadEntry
import app.friendflix.android.bridge.DownloadRequest
import app.friendflix.android.bridge.DownloadSink
import app.friendflix.android.settings.StorageLocation
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app's download list and the bridge's [DownloadSink]. One WorkManager job per licence (unique name [workName], KEEP), so
 * handing the same licence over twice never starts a second download. Calls from the bridge come on the UI thread and only touch the
 * small in-memory table; scheduling happens on [Downloads.scope].
 *
 * Kotlin-side states ([observe]) are the [DownloadState] web names plus `unavailable` (the card holding it is not mounted). [list]
 * is what the web UI gets: the same with `unavailable` shown as `paused` (its state set has no such name).
 */
class DownloadQueue(private val d: Downloads) : DownloadSink {
    private val prep = MutableStateFlow<Map<String, Int>>(emptyMap())
    private val mounted = MutableStateFlow(mountedNow())
    private val jobs = ConcurrentLinkedQueue<Job>()
    private val sessionNoticeShown = AtomicBoolean(false)

    // ---- bridge (UI thread) ----

    override fun enqueue(req: DownloadRequest): Boolean {
        d.store.insertIfAbsent(
            DownloadRecord(
                licenseId = req.licenseId, itemId = req.itemId, profileId = req.profileId, state = DownloadState.QUEUED,
                file = DownloadFiles.video(req.licenseId), location = StorageLocation.PHONE, // the worker picks the place on its first run
            ),
        )
        val cur = d.store.get(req.licenseId) ?: return false
        resumeSignedOut() // a new hand-over means the user is signed in again
        if (cur.state != DownloadState.DONE && cur.state != DownloadState.EXPIRED) launch { schedule(req.licenseId, ExistingWorkPolicy.KEEP) }
        return true
    }

    override fun list(): List<DownloadEntry> = entries(web = true)

    override fun delete(licenseId: String): Boolean {
        val rec = d.store.remove(licenseId) ?: return false
        d.workManager.cancelUniqueWork(workName(licenseId))
        clearPrep(licenseId)
        // files go right away (a few unlinks); anything a still-stopping worker leaves behind is an orphan, swept on the next start
        deleteFiles(rec)
        if (rec.state != DownloadState.EXPIRED) LicenceDeleteWorker.enqueue(d.workManager, deleteName(licenseId), licenseId, rec.profileId)
        return true
    }

    // ---- Kotlin API (Tasks 7, 8, 10, 11) ----

    /** Every download with its live state (`unavailable` while its card is out). */
    fun observe(): Flow<List<DownloadEntry>> = combine(d.store.records, prep, mounted) { _, _, _ -> entries(web = false) }

    /** Same as [observe] in the web UI's state names (what [list] returns); the shell forwards changes as bridge events. */
    fun observeWeb(): Flow<List<DownloadEntry>> = combine(d.store.records, prep, mounted) { _, _, _ -> entries(web = true) }

    /** The stored row (title, files, location) for the offline list and the player. */
    fun record(licenseId: String): DownloadRecord? = d.store.get(licenseId)

    /** The folder a download's files are in, or null while its storage is not mounted. */
    fun dirOf(r: DownloadRecord): File? = d.locations.dirIfMounted(r.location)

    /** App start / sign-in: signed-out downloads continue, unfinished ones get their job back, orphan files go. */
    fun resumeAll() {
        resumeSignedOut()
        refreshAvailability()
        launch {
            for (r in d.store.all()) if (r.state in UNFINISHED && r.state != DownloadState.SIGNED_OUT) schedule(r.licenseId, ExistingWorkPolicy.KEEP)
            sweepOrphans()
        }
    }

    /** A finished file failed its integrity check (player / verification): delete it and download it again. */
    fun redownload(licenseId: String) {
        val rec = d.store.get(licenseId) ?: return
        d.workManager.cancelUniqueWork(workName(licenseId))
        deleteFiles(rec)
        d.store.update(licenseId) { it.copy(state = DownloadState.QUEUED, bytes = 0, etag = null, subtitles = emptyList()) }
        launch { schedule(licenseId, ExistingWorkPolicy.REPLACE) }
    }

    /** Re-plans every unfinished job (e.g. after the Wi-Fi-only setting changed); a running transfer resumes by Range. */
    fun rescheduleAll() {
        launch { for (r in d.store.all()) if (r.state in UNFINISHED && r.state != DownloadState.SIGNED_OUT) schedule(r.licenseId, ExistingWorkPolicy.REPLACE) }
    }

    /** Re-reads which volumes are mounted (card inserted / removed). */
    fun refreshAvailability() { mounted.value = mountedNow() }

    /** Makes [to] the place for new downloads and moves finished ones there (its own worker: copy, verify, delete the source). */
    suspend fun move(to: StorageLocation) {
        d.settings.setStorage(to)
        StorageMoveWorker.enqueue(d.workManager, to)
    }

    /** Waits until scheduling started so far has reached WorkManager (tests). */
    suspend fun awaitScheduled() {
        while (true) {
            val j = jobs.peek() ?: return
            j.join()
            jobs.remove(j)
        }
    }

    // ---- used by the workers ----

    internal fun setPrep(licenseId: String, percent: Int) { prep.value = prep.value + (licenseId to percent) }
    internal fun clearPrep(licenseId: String) { if (licenseId in prep.value) prep.value = prep.value - licenseId }

    /** 401: every unfinished download waits for the next sign-in; one notification, no jobs left that would ask again. */
    internal fun onSessionExpired() {
        d.store.updateAll { if (it.state in UNFINISHED) it.copy(state = DownloadState.SIGNED_OUT) else it }
        d.workManager.cancelAllWorkByTag(TAG)
        if (sessionNoticeShown.compareAndSet(false, true)) d.notifier.sessionExpired()
    }

    /** Revoked or expired: files deleted, the row stays as `expired`. */
    internal fun expire(licenseId: String) {
        val rec = d.store.get(licenseId) ?: return
        deleteFiles(rec)
        clearPrep(licenseId)
        d.store.update(licenseId) { it.copy(state = DownloadState.EXPIRED, bytes = 0, subtitles = emptyList()) }
    }

    /** The server no longer knows the licence (deleted elsewhere): files and row go. */
    internal fun removeGone(licenseId: String) {
        val rec = d.store.remove(licenseId) ?: return
        clearPrep(licenseId)
        deleteFiles(rec)
    }

    internal fun deleteFiles(rec: DownloadRecord) {
        for (kind in StorageLocation.entries) {
            val dir = d.locations.dirIfMounted(kind) ?: continue
            for (name in DownloadFiles.all(rec)) {
                File(dir, name).delete()
                File(dir, "$name$PART").delete()
            }
        }
    }

    // ---- internals ----

    private fun resumeSignedOut() {
        val resumed = d.store.all().filter { it.state == DownloadState.SIGNED_OUT }.map { it.licenseId }
        if (resumed.isEmpty()) return
        d.store.updateAll { if (it.state == DownloadState.SIGNED_OUT) it.copy(state = DownloadState.QUEUED) else it }
        sessionNoticeShown.set(false)
        d.notifier.clearSessionExpired()
        launch { resumed.forEach { schedule(it, ExistingWorkPolicy.KEEP) } }
    }

    private suspend fun schedule(licenseId: String, policy: ExistingWorkPolicy) {
        val wifiOnly = d.settings.wifiOnly.first()
        val req = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setInputData(workDataOf(DownloadWorker.KEY_LICENSE to licenseId))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .addTag(TAG)
            .build()
        d.workManager.enqueueUniqueWork(workName(licenseId), policy, req)
    }

    private fun sweepOrphans() {
        for (kind in StorageLocation.entries) {
            val dir = d.locations.dirIfMounted(kind) ?: continue
            for (f in dir.listFiles().orEmpty()) {
                val owner = DownloadFiles.owner(f.name) ?: continue
                val rec = d.store.get(owner)
                if (rec == null || rec.state == DownloadState.EXPIRED) f.delete()
            }
        }
    }

    private fun launch(block: suspend () -> Unit) {
        jobs.add(d.scope.launch { block() })
        jobs.removeIf { it.isCompleted }
    }

    private fun mountedNow(): Map<StorageLocation, Boolean> = StorageLocation.entries.associateWith { d.locations.isMounted(it) }

    private fun entries(web: Boolean): List<DownloadEntry> {
        val now = System.currentTimeMillis()
        val m = mounted.value
        val p = prep.value
        return d.store.all().map { r ->
            val state = when {
                m[r.location] != true && r.state != DownloadState.EXPIRED -> if (web) "paused" else UNAVAILABLE
                r.state == DownloadState.DONE && r.expiresAt in 1..<now -> "expired"
                else -> r.state.web
            }
            val progress = when {
                r.state == DownloadState.DONE -> 1.0
                r.state == DownloadState.PREPARING -> (p[r.licenseId] ?: 0) / 100.0
                r.total > 0 -> (r.bytes.toDouble() / r.total).coerceIn(0.0, 1.0)
                else -> 0.0
            }
            DownloadEntry(r.licenseId, r.itemId, state, progress, r.bytes, r.expiresAt)
        }
    }

    companion object {
        const val TAG = "ff-download"
        const val UNAVAILABLE = "unavailable"
        internal const val PART = ".part"
        private const val BACKOFF_SECONDS = 30L
        private val UNFINISHED = setOf(DownloadState.QUEUED, DownloadState.PREPARING, DownloadState.DOWNLOADING, DownloadState.PAUSED, DownloadState.SIGNED_OUT)

        fun workName(licenseId: String) = "dl-$licenseId"

        /** Listens for cards coming and going for the life of the process (App.onCreate); builds the download graph only on an event. */
        fun watchVolumes(context: Context) {
            val filter = IntentFilter().apply {
                listOf(Intent.ACTION_MEDIA_MOUNTED, Intent.ACTION_MEDIA_UNMOUNTED, Intent.ACTION_MEDIA_REMOVED, Intent.ACTION_MEDIA_EJECT, Intent.ACTION_MEDIA_BAD_REMOVAL)
                    .forEach(::addAction)
                addDataScheme("file")
            }
            ContextCompat.registerReceiver(context.applicationContext, object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) = Downloads.get(c).queue.refreshAvailability()
            }, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        }
        fun deleteName(licenseId: String) = "dl-del-$licenseId"
    }
}
