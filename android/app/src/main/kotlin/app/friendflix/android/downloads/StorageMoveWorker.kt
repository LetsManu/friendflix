// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.friendflix.android.crypto.EncryptedReader
import app.friendflix.android.crypto.KeysUnavailableException
import app.friendflix.android.settings.StorageLocation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Moves downloads to another storage location, one download at a time, so an interrupted move is resumable: the files are copied
 * as `.part`, checked (sizes; a finished video must open as a complete encrypted file), renamed, then the row switches location (the
 * commit point) and only then are the source files deleted. A download that is still transferring stays where it is (it finishes
 * there; a later move picks it up). Downloads without any file just switch location.
 */
class StorageMover(private val d: Downloads) {
    /** True when everything that can move is at [to]; false = try again later (a volume or the keys are unavailable). */
    fun moveAll(to: StorageLocation): Boolean {
        var complete = true
        for (rec in d.store.all()) {
            if (rec.location == to || rec.state == DownloadState.EXPIRED) continue
            val src = d.locations.dirIfMounted(rec.location)
            val dst = d.locations.dirIfMounted(to) ?: return false
            if (src == null) { complete = false; continue } // its card is out: nothing can be read or deleted now
            val names = DownloadFiles.all(rec).filter { File(src, it).exists() }
            if (rec.state != DownloadState.DONE) {
                if (names.isEmpty()) d.store.update(rec.licenseId) { it.copy(location = to) }
                continue // partly downloaded: a worker may be writing it
            }
            try {
                copyAll(rec, names, src, dst)
            } catch (_: KeysUnavailableException) { // an IOException too: must come first
                names.forEach { File(dst, it + DownloadQueue.PART).delete() }
                return false
            } catch (_: IOException) {
                Log.w(TAG, "move failed for one download; will retry")
                names.forEach { File(dst, it + DownloadQueue.PART).delete() }
                complete = false
                continue
            }
            if (d.store.update(rec.licenseId) { it.copy(location = to) } == null) { // deleted meanwhile
                names.forEach { File(dst, it).delete() }
            }
            names.forEach { File(src, it).delete() }
        }
        return complete
    }

    private fun copyAll(rec: DownloadRecord, names: List<String>, src: File, dst: File) {
        if (names.sumOf { File(src, it).length() } > d.locations.freeBytes(dst)) throw IOException("no space")
        for (name in names) {
            val from = File(src, name)
            val part = File(dst, name + DownloadQueue.PART)
            FileInputStream(from).use { input -> FileOutputStream(part).use { out -> input.copyTo(out, BUFFER); out.fd.sync() } }
            if (part.length() != from.length()) throw IOException("size mismatch")
        }
        if (rec.file in names) {
            // the moved video must still be a complete file under our keys (checks the final record's tag)
            EncryptedReader(File(dst, rec.file + DownloadQueue.PART), d.keys.keys()).use { r ->
                if (rec.bytes > 0 && r.length != rec.bytes) throw IOException("length mismatch")
            }
        }
        for (name in names) {
            val target = File(dst, name)
            target.delete()
            if (!File(dst, name + DownloadQueue.PART).renameTo(target)) throw IOException("rename failed")
        }
    }

    private companion object {
        const val TAG = "FFDownloadMove"
        const val BUFFER = 256 * 1024
    }
}

class StorageMoveWorker(context: Context, params: WorkerParameters, private val d: Downloads) : CoroutineWorker(context, params) {
    constructor(context: Context, params: WorkerParameters) : this(context, params, Downloads.get(context))

    override suspend fun doWork(): Result {
        val to = StorageLocation.entries.firstOrNull { it.name == inputData.getString(KEY_TARGET) } ?: return Result.failure()
        val done = withContext(Dispatchers.IO) { StorageMover(d).moveAll(to) }
        d.queue.refreshAvailability()
        return if (done) Result.success() else Result.retry()
    }

    companion object {
        const val NAME = "dl-move"
        private const val KEY_TARGET = "target"

        fun enqueue(wm: WorkManager, to: StorageLocation) {
            val req = OneTimeWorkRequestBuilder<StorageMoveWorker>()
                .setInputData(workDataOf(KEY_TARGET to to.name))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 60, TimeUnit.SECONDS)
                .addTag(DownloadQueue.TAG + "-move")
                .build()
            wm.enqueueUniqueWork(NAME, ExistingWorkPolicy.REPLACE, req)
        }
    }
}
