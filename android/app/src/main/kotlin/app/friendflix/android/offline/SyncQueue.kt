// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import android.util.Log
import app.friendflix.android.downloads.ProgressAnswer
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.SessionExpired
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * One offline watch state, as the server's `POST /api/downloads/progress` takes it. [at] is the device time it was watched (epoch ms):
 * the server applies an event only when it is newer than the title's own last-played time, so a later online viewing wins.
 */
data class SyncEvent(
    val downloadId: String,
    val itemId: String,
    val profileId: String,
    val positionTicks: Long,
    val played: Boolean,
    val at: Long,
)

enum class FlushResult {
    /** everything of the profile that was queued went to the server */
    DONE,
    /** nothing to send */
    NOTHING,
    /** 401: stopped, the events stay until the next sign-in; no retry */
    SIGNED_OUT,
    /** no network / server trouble / other profile active: stopped, the events stay for the next start or reconnect */
    LATER,
}

/**
 * Position / watched changes made offline, sent on the next start or reconnect (the web's `progressQueue` + `flushProgress`).
 * Persisted in `filesDir/sync-queue.json` (atomic writes off the calling thread). One entry per profile and title: the newest [SyncEvent.at]
 * wins. [flush] sends only the active profile's entries (others wait until that profile is active again), at most 200 per request.
 * The server decides "newer wins" against its own last-played time; events it skips (its state is newer) or rejects are dropped, an
 * event that arrived while a request was in flight is kept. A 401 stops the flush at once; nothing here retries on its own.
 */
class SyncQueue(file: File, onWrite: () -> Unit = {}) {
    private val store = JsonFile(file, onWrite)
    private val events = LinkedHashMap<String, SyncEvent>()
    private val flushing = Mutex()

    init {
        val arr = store.read()?.optJSONArray("events") ?: JSONArray()
        for (i in 0 until arr.length()) parse(arr.optJSONObject(i))?.let { events[key(it)] = it }
    }

    /** Queues [e] unless a newer state of the same title is already queued. */
    @Synchronized
    fun add(e: SyncEvent) {
        val cur = events[key(e)]
        if (cur != null && cur.at > e.at) return
        events[key(e)] = e
        save()
    }

    @Synchronized
    fun pending(): List<SyncEvent> = events.values.toList()

    /** Sends [profileId]'s queued events through [api]. Blocking network work runs on the IO dispatcher; one flush at a time. */
    suspend fun flush(api: ServerApi, profileId: String): FlushResult = flushing.withLock {
        withContext(Dispatchers.IO) {
            val mine = pending().filter { it.profileId == profileId }
            if (mine.isEmpty()) return@withContext FlushResult.NOTHING
            for (part in mine.chunked(ServerApi.MAX_IDS)) {
                val answer = try {
                    api.progress(profileId, JSONArray(part.map(::toWire)))
                } catch (_: SessionExpired) {
                    return@withContext FlushResult.SIGNED_OUT
                } catch (e: IOException) {
                    Log.i(TAG, "progress sync postponed: ${e.javaClass.simpleName}")
                    return@withContext FlushResult.LATER
                }
                when (answer) {
                    is ProgressAnswer.Taken, ProgressAnswer.Rejected -> removeSent(part)
                    ProgressAnswer.Later -> return@withContext FlushResult.LATER
                }
            }
            FlushResult.DONE
        }
    }

    /** Drops everything queued (sign-out of this device / another server: the positions belong to the old account). */
    @Synchronized
    fun clear() {
        events.clear()
        save()
    }

    /** Blocks until every change so far is on disk. */
    fun flushToDisk() = store.flush()

    /** Removes what was sent, keeping an entry that changed meanwhile (a newer state queued during the request). */
    @Synchronized
    private fun removeSent(sent: List<SyncEvent>) {
        var changed = false
        for (e in sent) {
            val cur = events[key(e)] ?: continue
            if (cur.at <= e.at) { events.remove(key(e)); changed = true }
        }
        if (changed) save()
    }

    private fun save() {
        val arr = JSONArray()
        events.values.forEach { arr.put(toJson(it)) }
        store.save(JSONObject().put("version", 1).put("events", arr))
    }

    private fun key(e: SyncEvent) = "${e.profileId}/${e.itemId}"

    private fun toWire(e: SyncEvent) = JSONObject()
        .put("downloadId", e.downloadId).put("itemId", e.itemId).put("positionTicks", e.positionTicks).put("played", e.played).put("at", e.at)

    private fun toJson(e: SyncEvent) = toWire(e).put("profileId", e.profileId)

    private fun parse(o: JSONObject?): SyncEvent? = try {
        o?.let { SyncEvent(it.getString("downloadId"), it.getString("itemId"), it.getString("profileId"), it.getLong("positionTicks"), it.getBoolean("played"), it.getLong("at")) }
    } catch (_: JSONException) {
        null
    }

    private companion object {
        const val TAG = "FFSyncQueue"
    }
}
