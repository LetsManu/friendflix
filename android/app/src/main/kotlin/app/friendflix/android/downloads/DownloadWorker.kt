// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.friendflix.android.crypto.EncryptedFormat
import app.friendflix.android.crypto.KeyProvider
import app.friendflix.android.crypto.KeysUnavailableException
import app.friendflix.android.settings.StorageLocation
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.HttpUrl
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * Downloads one licence (input [KEY_LICENSE]) into an [EncryptedWriter] file, then its text subtitles and artwork (also encrypted).
 *
 * Flow (mirrors the web client): ask the backend about the licence (`GET /api/downloads/:id`): gone → remove; revoked / expired →
 * delete the files ([DownloadState.EXPIRED]); preparing → retry with backoff; failed → error. Ready → fetch `fileUrl` from the
 * writer's `resumeOffset()` with `Range` pinned by `If-Range: <ETag>`. A 206 must start exactly there and keep the ETag, else the
 * file starts over (new writer, new IV); a 200 always starts over; bytes from a different source are never appended under an old IV.
 * A 403/404/410 from the gateway never deletes by itself: the backend is asked again (licence + `POST /api/downloads/check`), and only
 * its revoked / expired / gone verdict deletes. Then `POST /api/downloads/:id/fetched`.
 *
 * 401 anywhere → every download [DownloadState.SIGNED_OUT], one notification, Result.failure (no retry loop). Keys unavailable,
 * storage not mounted, another profile active → [DownloadState.PAUSED], nothing deleted. Waits are fresh follow-up jobs with our own
 * delay (see [Run.later]); disk full or an unwritable folder → [DownloadState.ERROR] with a reason. Logs never contain cookies, URLs,
 * titles or keys.
 */
class DownloadWorker(context: Context, params: WorkerParameters, private val d: Downloads) : CoroutineWorker(context, params) {
    constructor(context: Context, params: WorkerParameters) : this(context, params, Downloads.get(context))

    override suspend fun doWork(): Result {
        val id = inputData.getString(KEY_LICENSE) ?: return Result.failure()
        if (!startable(id)) return finished(id)
        val run = Run(id, inputData.getInt(KEY_ROUND, 0))
        val lock = LOCKS.computeIfAbsent(id) { Mutex() } // a replaced job waits until the old one has closed its writer
        return try {
            withContext(Dispatchers.IO) {
                lock.withLock {
                    TRANSFERS.withPermit {
                        if (!startable(id)) return@withPermit finished(id)
                        coroutineScope {
                            // a stopped job cancels its HTTP call at once instead of waiting for the next read to return
                            val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
                                try { awaitCancellation() } finally { run.cancelCall() }
                            }
                            try { run.go() } finally { watcher.cancel() }
                        }
                    }
                }
            }
        } catch (_: SessionExpired) {
            Log.i(TAG, "session expired: downloads wait for sign-in")
            d.queue.onSessionExpired()
            Result.failure()
        } catch (_: IOException) { // network trouble talking to the API: plan the next try
            run.set(DownloadState.QUEUED)
            run.later(prep = false)
        }
    }

    private fun startable(id: String): Boolean = d.store.get(id)?.state.let { it != null && it != DownloadState.DONE && it != DownloadState.EXPIRED && it != DownloadState.SIGNED_OUT }

    private fun finished(id: String): Result = if (d.store.get(id)?.state == DownloadState.SIGNED_OUT) Result.failure() else Result.success()

    private sealed interface Step {
        data class Done(val bytes: Long) : Step
        data object Again : Step
        data object Retry : Step
        data object Denied : Step
        data object Stopped : Step
        data class Failed(val reason: String) : Step
    }

    private sealed interface Verdict {
        data class Final(val result: Result) : Verdict
        data class Active(val licence: Licence) : Verdict
    }

    private inner class Run(private val id: String, private val round: Int) {
        private var lastUpdate = 0L
        private var restarts = 0
        private var recoveries = 0
        /** bytes moved forward or a preparation finished in this run: the next wait starts again at [BASE_DELAY_MS] */
        private var progressed = false
        private val call = AtomicReference<Call?>()

        fun cancelCall() { call.get()?.cancel() }

        private fun rec() = d.store.get(id)

        /** Sets the state unless a sign-out or revocation happened meanwhile (those win; the job was cancelled for them). */
        fun set(state: DownloadState, error: String? = null) {
            d.store.update(id) { if (it.state in DownloadQueue.STICKY) it else it.copy(state = state, error = error) }
        }

        /**
         * Ends this run and plans a fresh one: 30 s doubling per round without progress, at most 5 min while the server prepares
         * and 10 min otherwise; after progress it starts at 30 s again. Never WorkManager's retry backoff (it never resets).
         */
        suspend fun later(prep: Boolean): Result {
            val k = if (progressed) 0 else round
            val delay = minOf(BASE_DELAY_MS shl minOf(k, MAX_SHIFT), if (prep) MAX_PREP_DELAY_MS else MAX_RETRY_DELAY_MS)
            d.queue.scheduleFollowUp(id, k + 1, delay)
            return Result.success()
        }

        private suspend fun paused(why: String): Result {
            Log.i(TAG, "paused: $why")
            set(DownloadState.PAUSED)
            return later(prep = false)
        }

        private fun failed(reason: String): Result {
            Log.w(TAG, "download failed: $reason")
            set(DownloadState.ERROR, reason)
            d.queue.clearPrep(id)
            return Result.failure()
        }

        suspend fun go(): Result {
            var rec = rec() ?: return Result.success()
            rec = chooseLocation(rec)
            val dir = d.locations.dirIfMounted(rec.location) ?: return paused("storage not mounted")
            val keys = try { d.keys.keys() } catch (_: KeysUnavailableException) { return paused("keys unavailable") }
            val api = d.api() ?: return paused("no server")

            val wasPreparing = rec.state == DownloadState.PREPARING
            val lic = when (val a = verdict(api, rec, checkWithServer = false)) {
                is Verdict.Final -> return a.result
                is Verdict.Active -> a.licence
            }
            if (wasPreparing) progressed = true
            d.store.update(id) {
                it.copy(
                    title = lic.title, expiresAt = lic.expiresAt, lastCheck = System.currentTimeMillis(), total = lic.bytes ?: it.total,
                    validUntil = if (lic.validUntil > 0) lic.validUntil else it.validUntil,
                )
            }
            val url = api.resolve(lic.fileUrl) ?: run {
                Log.w(TAG, "file url is not on the server's origin")
                return failed(ERR_IO)
            }

            val video = File(dir, rec.file)
            lic.bytes?.let { size ->
                val need = cipherSize(size) - (if (video.exists()) video.length() else 0L)
                if (need > 0 && d.locations.freeBytes(dir) < need + SPACE_MARGIN) return failed(ERR_NO_SPACE)
            }
            val bytes = when (val s = transfer(api, url, video, keys, dir, lic.bytes)) {
                is Step.Done -> s.bytes
                is Step.Failed -> return failed(s.reason)
                Step.Denied -> return when (val v = verdict(api, rec, checkWithServer = true)) {
                    is Verdict.Final -> v.result
                    is Verdict.Active -> { set(DownloadState.QUEUED); later(prep = false) } // still valid: the gateway was not ready yet
                }
                Step.Stopped -> return if (rec() == null) { video.delete(); Result.success() } else Result.retry()
                Step.Retry, Step.Again -> { set(DownloadState.QUEUED); return later(prep = false) }
            }

            val subs = subtitles(api, lic, dir, keys)
            artwork(api, lic.poster, File(dir, DownloadFiles.poster(id)), keys)
            artwork(api, lic.backdrop, File(dir, DownloadFiles.backdrop(id)), keys)
            if (rec() == null) { d.queue.deleteFiles(rec); return Result.success() } // deleted meanwhile
            d.store.update(id) {
                if (it.state == DownloadState.EXPIRED) it
                else it.copy(state = DownloadState.DONE, bytes = bytes, total = bytes, subtitles = subs, error = null)
            }
            d.queue.clearPrep(id)
            try {
                api.markFetched(id, rec.profileId, bytes)
            } catch (_: SessionExpired) {
                d.queue.onSessionExpired() // this one is done; the others wait for the sign-in
            } catch (_: IOException) {
                // best effort: the licence stays "pending" on the server, which changes nothing for playback
            }
            return Result.success()
        }

        /** A fresh download (nothing on disk yet) goes to the place chosen in the settings, or the phone while the card is out. */
        private suspend fun chooseLocation(rec: DownloadRecord): DownloadRecord {
            if (rec.bytes > 0 || rec.etag != null) return rec
            val here = d.locations.dirIfMounted(rec.location)
            if (here != null && File(here, rec.file).exists()) return rec
            val want = d.settings.storage.first()
            val loc = if (d.locations.isMounted(want)) want else StorageLocation.PHONE
            return d.store.update(id) { it.copy(location = loc) } ?: rec
        }

        // ---- the backend's word on the licence ----

        private suspend fun verdict(api: ServerApi, rec: DownloadRecord, checkWithServer: Boolean): Verdict {
            val lic = when (val a = api.licence(id, rec.profileId)) {
                LicenceAnswer.Gone -> { Log.i(TAG, "licence gone on the server: removed"); d.queue.removeGone(id); return Verdict.Final(Result.success()) }
                LicenceAnswer.Wait -> return Verdict.Final(paused("server cannot answer for this licence now"))
                is LicenceAnswer.Found -> a.licence
            }
            if (lic.status == "deleted") { d.queue.removeGone(id); return Verdict.Final(Result.success()) }
            if (!lic.active || lic.expiresAt <= System.currentTimeMillis()) return expired()
            when (lic.prepStatus) {
                "ready" -> d.queue.clearPrep(id)
                "failed" -> return Verdict.Final(failed(ERR_PREP))
                else -> {
                    d.queue.setPrep(id, lic.prepPercent)
                    set(DownloadState.PREPARING)
                    return Verdict.Final(later(prep = true))
                }
            }
            if (checkWithServer && api.check(id, rec.profileId) == CheckAnswer.Revoked) return expired()
            return Verdict.Active(lic)
        }

        private fun expired(): Verdict {
            Log.i(TAG, "licence revoked or expired: files deleted")
            d.queue.expire(id)
            return Verdict.Final(Result.success())
        }

        // ---- the video file ----

        private suspend fun transfer(api: ServerApi, url: HttpUrl, file: File, keys: KeyProvider, dir: File, expected: Long?): Step {
            while (true) {
                if (restarts > MAX_RESTARTS) return Step.Retry
                if (recoveries > MAX_RECOVERIES) return Step.Failed(ERR_IO)
                val s = attempt(api, url, file, keys, dir, expected)
                if (s != Step.Again) return s
            }
        }

        private fun restart(file: File) {
            restarts++
            file.delete()
            d.store.update(id) { it.copy(etag = null, bytes = 0) }
        }

        /** A writer failure: disk full fails the download with a reason, anything else is retried a few times from resumeOffset(). */
        private fun writeFailed(e: IOException, dir: File): Step {
            val msg = e.message.orEmpty()
            if ("ENOSPC" in msg || msg.contains("No space left", ignoreCase = true) || d.locations.freeBytes(dir) < EncryptedFormat.CHUNK_SIZE * 2L) {
                return Step.Failed(ERR_NO_SPACE)
            }
            recoveries++
            return Step.Again
        }

        @Suppress("CyclomaticComplexMethod", "ReturnCount", "LongMethod")
        private suspend fun attempt(api: ServerApi, url: HttpUrl, file: File, keys: KeyProvider, dir: File, expected: Long?): Step {
            var writer = try { d.newWriter(file, keys) } catch (e: IOException) { return writeFailed(e, dir) }
            try {
                if (writer.isComplete) return Step.Done(writer.resumeOffset())
                var offset = writer.resumeOffset()
                val pin = rec()?.etag ?: if (offset > 0) { writer.close(); restart(file); return Step.Again } else null
                val c = api.file(url, offset, pin)
                call.set(c)
                try {
                    currentCoroutineContext().ensureActive()
                    c.execute().use { resp ->
                        var total: Long
                        when (resp.code) {
                            401 -> throw SessionExpired()
                            206 -> {
                                val cr = contentRange(resp.header("content-range"))
                                val tag = strongEtag(resp.header("etag"))
                                if (offset == 0L || cr == null || cr.first != offset || tag != pin) { // pinned: same start, same ETag
                                    Log.i(TAG, "resume not pinned to the same file: starting over")
                                    writer.close(); restart(file); return Step.Again
                                }
                                total = cr.second
                            }
                            200 -> {
                                if (offset > 0) { // the source changed (If-Range failed): new file, new IV
                                    writer.close(); restart(file)
                                    writer = try { d.newWriter(file, keys) } catch (e: IOException) { return writeFailed(e, dir) }
                                    offset = 0
                                }
                                total = resp.body.contentLength()
                                val tag = strongEtag(resp.header("etag"))
                                d.store.update(id) { it.copy(etag = tag) }
                            }
                            416 -> {
                                val size = contentRange(resp.header("content-range"))?.second
                                if (size != null && size == offset) {
                                    try { writer.finish() } catch (e: IOException) { return writeFailed(e, dir) }
                                    return Step.Done(offset)
                                }
                                writer.close(); restart(file); return Step.Again
                            }
                            403, 404, 410 -> return Step.Denied
                            else -> { Log.i(TAG, "file request answered ${resp.code}"); return Step.Retry }
                        }
                        d.store.update(id) {
                            it.copy(state = if (it.state in DownloadQueue.STICKY) it.state else DownloadState.DOWNLOADING, bytes = offset, total = if (total > 0) total else it.total)
                        } ?: return Step.Stopped // deleted meanwhile
                        if (!progress(offset, total, force = true)) return Step.Stopped
                        val src = resp.body.source()
                        val buf = ByteArray(BUFFER)
                        var written = offset
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            if (isStopped) return Step.Stopped
                            val n = try { src.read(buf) } catch (_: IOException) { return short(written) } // network: plan another try
                            if (n == -1) break
                            try {
                                writer.append(buf, 0, n)
                            } catch (e: IOException) { // the writer is failed: reopen and continue from its resumeOffset()
                                return writeFailed(e, dir)
                            }
                            written += n
                            progressed = true
                            if (!progress(written, total, force = false)) return Step.Stopped
                        }
                        val want = if (total > 0) total else expected
                        if (want != null && written != want) return short(written) // cut short: keep what came, resume later
                        try { writer.finish() } catch (e: IOException) { return writeFailed(e, dir) }
                        return Step.Done(written)
                    }
                } catch (e: IOException) {
                    if (e is SessionExpired) throw e
                    return Step.Retry
                } finally {
                    call.set(null)
                }
            } finally {
                writer.close()
            }
        }

        private fun short(written: Long): Step {
            d.store.update(id) { it.copy(bytes = written) }
            return Step.Retry
        }

        /** Stores progress and updates the notification at most every [PROGRESS_MS]; false when the download was deleted meanwhile. */
        private suspend fun progress(bytes: Long, total: Long, force: Boolean): Boolean {
            val now = SystemClock.elapsedRealtime()
            if (!force && now - lastUpdate < PROGRESS_MS) return true
            lastUpdate = now
            d.store.update(id) { it.copy(bytes = bytes) } ?: return false
            val pct = if (total > 0) (bytes * 100 / total).toInt() else 0
            try {
                setForeground(d.notifier.foreground(id, pct))
            } catch (_: IllegalStateException) {
                // not allowed to start a foreground service right now (background start limits): keep going as normal work
            }
            return true
        }

        // ---- subtitles and artwork (best effort, encrypted, licence-based names) ----

        private fun subtitles(api: ServerApi, lic: Licence, dir: File, keys: KeyProvider): List<SubtitleFile> {
            val out = mutableListOf<SubtitleFile>()
            lic.subtitles.forEachIndexed { i, (lang, path) ->
                val ext = path.substringBefore('?').lowercase().let { p -> TEXT_SUBS.firstOrNull { p.endsWith(".$it") } } ?: return@forEachIndexed // image subtitles skipped
                val url = api.resolve(path) ?: return@forEachIndexed
                val name = DownloadFiles.subtitle(id, i, ext)
                if (small(api, url, File(dir, name), keys, MAX_SUBTITLE)) out += SubtitleFile(lang.take(MAX_LANG), name)
            }
            return out
        }

        private fun artwork(api: ServerApi, path: String?, file: File, keys: KeyProvider) {
            val url = path?.let { api.resolve(it) } ?: return
            small(api, url, file, keys, MAX_ARTWORK)
        }

        private fun small(api: ServerApi, url: HttpUrl, file: File, keys: KeyProvider, max: Int): Boolean {
            val bytes = try { api.small(url, max) } catch (e: IOException) { if (e is SessionExpired) throw e; null } ?: return false
            val part = File(file.path + DownloadQueue.PART)
            return try {
                part.delete() // always a new file: a new IV for whatever the server sends now
                d.newWriter(part, keys).use { w -> w.append(bytes); w.finish() }
                file.delete()
                part.renameTo(file)
            } catch (_: IOException) {
                part.delete()
                false
            }
        }
    }

    companion object {
        const val KEY_LICENSE = "licenseId"
        /** how many runs in a row made no progress (drives the delay of the next one) */
        const val KEY_ROUND = "round"
        const val ERR_NO_SPACE = "noSpace"
        const val ERR_IO = "io"
        const val ERR_PREP = "prepFailed"
        private const val BASE_DELAY_MS = 30_000L
        private const val MAX_PREP_DELAY_MS = 5 * 60_000L
        private const val MAX_RETRY_DELAY_MS = 10 * 60_000L
        private const val MAX_SHIFT = 10
        private const val SPACE_MARGIN = 8L shl 20
        private const val TAG = "FFDownload"
        private const val BUFFER = 64 * 1024
        private const val PROGRESS_MS = 1_000L
        private const val MAX_RESTARTS = 2
        private const val MAX_RECOVERIES = 3
        private const val MAX_SUBTITLE = 10 shl 20
        private const val MAX_ARTWORK = 5 shl 20
        private const val MAX_LANG = 12
        private val TEXT_SUBS = listOf("vtt", "srt")

        /** The gateway allows two open downloads per account; more would only be answered 429. */
        private val TRANSFERS = Semaphore(2)

        /** One run per licence at a time (a REPLACE must never have two writers on one file). */
        private val LOCKS = ConcurrentHashMap<String, Mutex>()

        /** On-disk size of an encrypted file holding [plain] bytes (header + one tag per 1 MiB record, final record included). */
        internal fun cipherSize(plain: Long): Long {
            val chunk = EncryptedFormat.CHUNK_SIZE.toLong()
            return EncryptedFormat.HEADER_SIZE + plain + (plain / chunk + 1) * EncryptedFormat.TAG_SIZE
        }

        /** `bytes START-END/SIZE` → (START, SIZE), SIZE -1 when unknown; the 416 form (unsatisfied range, star) → (-1, SIZE). */
        internal fun contentRange(h: String?): Pair<Long, Long>? {
            if (h == null) return null
            Regex("^bytes (\\d+)-(\\d+)/(\\d+|\\*)$").find(h.trim())?.let { m ->
                return m.groupValues[1].toLong() to (m.groupValues[3].toLongOrNull() ?: -1L)
            }
            Regex("^bytes \\*/(\\d+)$").find(h.trim())?.let { m -> return -1L to m.groupValues[1].toLong() }
            return null
        }

        /** Only a strong validator can pin a resume (If-Range ignores weak ones). */
        internal fun strongEtag(h: String?): String? = h?.trim()?.takeIf { it.startsWith("\"") && it.endsWith("\"") && it.length in 3..200 }
    }
}
