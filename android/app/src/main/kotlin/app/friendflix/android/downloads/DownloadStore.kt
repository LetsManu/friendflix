// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import app.friendflix.android.settings.StorageLocation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Lifecycle of one download.
 * [PAUSED]: waiting for something transient (keys, storage card, profile, server); the worker retries with backoff.
 * [SIGNED_OUT]: the session ended (401); no work is scheduled until the app starts again or a new download is handed over.
 * [EXPIRED]: the licence was revoked or ran out; the files are deleted, the row stays so the UI can say so.
 */
enum class DownloadState(val web: String) {
    QUEUED("queued"), PREPARING("preparing"), DOWNLOADING("downloading"), PAUSED("paused"), SIGNED_OUT("paused"),
    DONE("done"), ERROR("error"), EXPIRED("expired"),
}

/** One stored text subtitle: its language and the encrypted file next to the video. */
data class SubtitleFile(val lang: String, val file: String)

/**
 * One row of the download table. [file] and the [subtitles] files live in the `downloads` folder of [location]; names are built
 * from the licence id ([DownloadFiles]), never from titles. [title] is only for the offline list (Task 7) and is never logged.
 * [bytes] plaintext bytes on disk, [total] expected size (0 = unknown), [expiresAt]/[lastCheck] epoch ms, [etag] pins resumes.
 */
data class DownloadRecord(
    val licenseId: String,
    val itemId: String,
    val profileId: String,
    val state: DownloadState,
    val bytes: Long = 0,
    val total: Long = 0,
    val file: String,
    val subtitles: List<SubtitleFile> = emptyList(),
    val expiresAt: Long = 0,
    val lastCheck: Long = 0,
    val etag: String? = null,
    val location: StorageLocation = StorageLocation.PHONE,
    val title: String = "",
)

/** File names of a download: everything starts with the licence id (so orphans can be found), nothing contains a title. */
object DownloadFiles {
    fun video(licenseId: String) = "$licenseId.ffv"
    fun subtitle(licenseId: String, index: Int, ext: String) = "$licenseId.s$index.$ext"
    fun poster(licenseId: String) = "$licenseId.poster"
    fun backdrop(licenseId: String) = "$licenseId.backdrop"
    /** The licence id a download file belongs to, or null for a foreign name. */
    fun owner(name: String): String? = name.substringBefore('.').takeIf { it.isNotEmpty() && it != name && OWNER.matches(it) }
    /** Every file of [r] (video, subtitles, artwork). */
    fun all(r: DownloadRecord): List<String> = listOf(r.file, poster(r.licenseId), backdrop(r.licenseId)) + r.subtitles.map { it.file }
    private val OWNER = Regex("^[A-Za-z0-9-]{1,64}$")
}

/**
 * The download table: a small JSON file in internal storage (never on the card), rewritten atomically on every change, with the
 * current rows as a [StateFlow]. All writes are serialized; reads are lock-free snapshots.
 */
class DownloadStore(private val file: File) {
    private val state = MutableStateFlow(load())
    val records: StateFlow<Map<String, DownloadRecord>> = state.asStateFlow()

    fun get(licenseId: String): DownloadRecord? = state.value[licenseId]
    fun all(): List<DownloadRecord> = state.value.values.toList()

    /** Adds [r] unless a row for its licence exists; true when it was added. */
    @Synchronized
    fun insertIfAbsent(r: DownloadRecord): Boolean {
        if (state.value.containsKey(r.licenseId)) return false
        commit(state.value + (r.licenseId to r))
        return true
    }

    /** Changes one row; null (and no write) when it does not exist. */
    @Synchronized
    fun update(licenseId: String, change: (DownloadRecord) -> DownloadRecord): DownloadRecord? {
        val cur = state.value[licenseId] ?: return null
        val next = change(cur)
        if (next != cur) commit(state.value + (licenseId to next.copy(licenseId = licenseId)))
        return next
    }

    /** Changes every row at once (one write). */
    @Synchronized
    fun updateAll(change: (DownloadRecord) -> DownloadRecord) {
        val next = state.value.mapValues { (id, r) -> change(r).copy(licenseId = id) }
        if (next != state.value) commit(next)
    }

    @Synchronized
    fun remove(licenseId: String): DownloadRecord? {
        val cur = state.value[licenseId] ?: return null
        commit(state.value - licenseId)
        return cur
    }

    private fun commit(next: Map<String, DownloadRecord>) {
        write(next)
        state.value = next
    }

    private fun write(rows: Map<String, DownloadRecord>) {
        val arr = JSONArray()
        rows.values.forEach { arr.put(toJson(it)) }
        val text = JSONObject().put("version", VERSION).put("downloads", arr).toString()
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        FileOutputStream(tmp).use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        if (!tmp.renameTo(file)) throw IOException("cannot replace download table")
    }

    private fun load(): Map<String, DownloadRecord> {
        if (!file.exists()) return emptyMap()
        return try {
            val arr = JSONObject(file.readText(Charsets.UTF_8)).getJSONArray("downloads")
            (0 until arr.length()).mapNotNull { fromJson(arr.getJSONObject(it)) }.associateBy { it.licenseId }
        } catch (_: JSONException) {
            emptyMap() // unreadable table: the files become orphans and are swept; the web UI can hand the licences over again
        } catch (_: IOException) {
            emptyMap()
        }
    }

    private fun toJson(r: DownloadRecord) = JSONObject()
        .put("licenseId", r.licenseId).put("itemId", r.itemId).put("profileId", r.profileId).put("state", r.state.name)
        .put("bytes", r.bytes).put("total", r.total).put("file", r.file)
        .put("subtitles", JSONArray().also { a -> r.subtitles.forEach { a.put(JSONObject().put("lang", it.lang).put("file", it.file)) } })
        .put("expiresAt", r.expiresAt).put("lastCheck", r.lastCheck).put("etag", r.etag ?: JSONObject.NULL)
        .put("location", r.location.name).put("title", r.title)

    private fun fromJson(o: JSONObject): DownloadRecord? = try {
        val subs = o.optJSONArray("subtitles") ?: JSONArray()
        DownloadRecord(
            licenseId = o.getString("licenseId"),
            itemId = o.getString("itemId"),
            profileId = o.getString("profileId"),
            state = DownloadState.entries.firstOrNull { it.name == o.optString("state") } ?: DownloadState.QUEUED,
            bytes = o.optLong("bytes"),
            total = o.optLong("total"),
            file = o.getString("file"),
            subtitles = (0 until subs.length()).map { i -> subs.getJSONObject(i).let { SubtitleFile(it.getString("lang"), it.getString("file")) } },
            expiresAt = o.optLong("expiresAt"),
            lastCheck = o.optLong("lastCheck"),
            etag = if (o.isNull("etag")) null else o.optString("etag"),
            location = StorageLocation.entries.firstOrNull { it.name == o.optString("location") } ?: StorageLocation.PHONE,
            title = o.optString("title"),
        )
    } catch (_: JSONException) {
        null
    }

    private companion object { const val VERSION = 1 }
}
