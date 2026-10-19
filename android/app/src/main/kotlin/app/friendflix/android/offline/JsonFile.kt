// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import android.util.Log
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.Executors

/**
 * A small JSON document in internal storage, the same pattern as the download table: the owner keeps the data in memory and hands
 * every change to [save]; one background thread writes the latest snapshot in order (tmp + fsync + rename), so callers on the UI
 * thread never touch the disk. [flush] waits for pending writes. An unreadable file is renamed aside and reads as empty.
 */
internal class JsonFile(private val file: File, private val onWrite: () -> Unit = {}) {
    private val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "ff-offline-store").apply { isDaemon = true } }
    private val lock = Any()
    private var latest: String? = null
    private var version = 0L
    private var written = 0L

    /** The stored document, or null when there is none (or it could not be read; it is then kept aside). */
    fun read(): JSONObject? {
        if (!file.exists()) return null
        return try {
            JSONObject(file.readText(Charsets.UTF_8))
        } catch (_: JSONException) {
            setAside()
        } catch (_: IOException) {
            setAside()
        }
    }

    /** Queues [doc] to be written (only the newest queued snapshot is actually written). */
    fun save(doc: JSONObject) {
        val text = doc.toString()
        synchronized(lock) {
            latest = text
            version++
        }
        writer.execute { persist() }
    }

    /** Blocks until every [save] so far is on disk. */
    fun flush() {
        writer.submit { persist() }.get()
    }

    private fun persist() {
        val (v, text) = synchronized(lock) { version to latest }
        if (v == written || text == null) return
        try {
            file.parentFile?.mkdirs()
            val tmp = File(file.path + ".tmp")
            FileOutputStream(tmp).use { out ->
                out.write(text.toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            if (!tmp.renameTo(file)) throw IOException("cannot replace")
            written = v
            onWrite()
        } catch (e: IOException) {
            Log.w(TAG, "offline state not saved: ${e.javaClass.simpleName}") // the next change tries again
        }
    }

    private fun setAside(): JSONObject? {
        val aside = File(file.path + ".corrupt-" + System.currentTimeMillis())
        Log.w(TAG, if (file.renameTo(aside)) "unreadable offline state kept aside" else "unreadable offline state could not be kept aside")
        return null
    }

    private companion object {
        const val TAG = "FFOfflineStore"
    }
}
