// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.bridge

import android.net.Uri
import app.friendflix.android.shell.OriginPolicy
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The listener logic behind `window.FriendFlixNative.postMessage(json)`, free of WebView types so it can be unit-tested.
 *
 * Request  `{"id": "<[A-Za-z0-9_-]{1,64}>", "method": "<name>", "args": {...}}` (no other keys, at most [MAX_MESSAGE_CHARS] chars)
 * Reply    `{"id": "<same>", "ok": true, "result": ...}` or `{"id": "<same>"|null, "ok": false, "error": "<code>"}`
 * Event    `{"event": "<name>", "detail": {...}}` (no id), sent to the latest accepted main frame via [emit]
 *
 * Only the main frame of the configured origin is served; everything else gets `forbidden` and is never remembered as reply target.
 */
class NativeBridge(
    private val policy: OriginPolicy,
    private val launcher: PlayerLauncher,
    private val downloads: DownloadSink,
    private val capabilities: Capabilities,
    private val openSettings: () -> Unit,
) {
    @Volatile private var eventSink: ReplySink? = null

    fun onMessage(message: String, sourceOrigin: Uri, isMainFrame: Boolean, reply: ReplySink) {
        // Frame and origin first: a foreign or nested frame learns nothing about the protocol (not even size or syntax errors).
        if (!isMainFrame || !policy.isAppOrigin(sourceOrigin)) return reply.post(error(forbiddenId(message), "forbidden"))
        if (message.length > MAX_MESSAGE_CHARS) return reply.post(error(null, "too_large"))
        val root = try { JSONObject(message) } catch (_: JSONException) { return reply.post(error(null, "bad_request")) }
        val id = (root.opt("id") as? String)?.takeIf { REQUEST_ID.matches(it) } ?: return reply.post(error(null, "bad_request"))
        eventSink = reply
        val out = try {
            ok(id, handle(root))
        } catch (e: BadRequest) {
            error(id, e.code)
        } catch (_: Exception) {
            error(id, "internal") // a backend that throws must not break the page's request
        }
        reply.post(out)
    }

    /** Drops the reply target (the page is gone, e.g. the WebView is destroyed) so nothing keeps a dead view alive. */
    fun detach() { eventSink = null }

    /** Best-effort request id for the `forbidden` answer; never parses oversized input. */
    private fun forbiddenId(message: String): String? {
        if (message.length > MAX_MESSAGE_CHARS) return null
        return try { (JSONObject(message).opt("id") as? String)?.takeIf { REQUEST_ID.matches(it) } } catch (_: JSONException) { null }
    }

    /** Pushes an unsolicited event to the page. Silent when no main frame has talked to us yet or the page is gone. */
    fun emit(event: String, detail: JSONObject) {
        val sink = eventSink ?: return
        try {
            sink.post(JSONObject().put("event", event).put("detail", detail).toString())
        } catch (_: Exception) {
            // the frame went away; the next page re-registers on its first message
        }
    }

    /** Pushes what changed between two download lists: `download` per new or changed entry, `downloadRemoved` per licence gone. */
    fun emitDownloadChanges(before: List<DownloadEntry>, after: List<DownloadEntry>) {
        val old = before.associateBy { it.licenseId }
        after.forEach { if (old[it.licenseId] != it) emit("download", entry(it)) }
        val now = after.mapTo(HashSet()) { it.licenseId }
        before.forEach { if (it.licenseId !in now) emit("downloadRemoved", JSONObject().put("licenseId", it.licenseId)) }
    }

    private fun handle(root: JSONObject): Any {
        if (root.keys().asSequence().any { it !in TOP_KEYS }) throw BadRequest("bad_request")
        val method = root.opt("method") as? String ?: throw BadRequest("bad_request")
        val raw = root.opt("args")
        val args = if (raw == null || raw == JSONObject.NULL) JSONObject() else raw as? JSONObject ?: throw BadRequest("bad_args")
        return when (method) {
            "capabilities" -> {
                only(args)
                JSONObject().put("api", API_VERSION).put("play", capabilities.play).put("download", capabilities.download).put("cast", capabilities.cast)
            }
            "play" -> launcher.launch(playRequest(args))
            "download" -> downloads.enqueue(downloadRequest(args))
            "downloads" -> {
                only(args)
                JSONArray().also { arr -> downloads.list().forEach { arr.put(entry(it)) } }
            }
            "deleteDownload" -> {
                only(args, "licenseId")
                downloads.delete(id(args, "licenseId"))
            }
            "openSettings" -> {
                only(args)
                openSettings()
                true
            }
            else -> throw BadRequest("unknown_method")
        }
    }

    private fun playRequest(a: JSONObject): PlayRequest {
        only(a, "itemId", "profileId", "startMs", "mediaSourceId", "audio", "subtitle")
        return PlayRequest(
            itemId = id(a, "itemId"),
            profileId = id(a, "profileId"),
            startMs = optMillis(a, "startMs"),
            mediaSourceId = optId(a, "mediaSourceId"),
            audio = optTrack(a, "audio"),
            subtitle = optTrack(a, "subtitle"),
        )
    }

    private fun downloadRequest(a: JSONObject): DownloadRequest {
        only(a, "licenseId", "itemId", "profileId")
        return DownloadRequest(id(a, "licenseId"), id(a, "itemId"), id(a, "profileId"))
    }

    private fun entry(e: DownloadEntry) = JSONObject()
        .put("licenseId", e.licenseId).put("itemId", e.itemId).put("state", e.state)
        .put("progress", e.progress).put("bytes", e.bytes).put("expiresAt", e.expiresAt)
        .put("title", e.title).put("profileId", e.profileId)
        .also { o -> e.error?.let { o.put("error", it) } }

    // ---- validation: anything unexpected is a BadRequest, never coerced ----
    private class BadRequest(val code: String) : Exception(code)

    private fun only(a: JSONObject, vararg allowed: String) {
        if (a.keys().asSequence().any { it !in allowed }) throw BadRequest("bad_args")
    }

    private fun id(a: JSONObject, key: String): String {
        val v = a.opt(key) as? String ?: throw BadRequest("bad_args")
        if (!ID.matches(v)) throw BadRequest("bad_args")
        return v
    }

    private fun optId(a: JSONObject, key: String): String? = if (absent(a, key)) null else id(a, key)

    private fun optTrack(a: JSONObject, key: String): String? {
        if (absent(a, key)) return null
        val v = a.opt(key) as? String ?: throw BadRequest("bad_args")
        if (!TRACK.matches(v)) throw BadRequest("bad_args")
        return v
    }

    private fun optMillis(a: JSONObject, key: String): Long? {
        if (absent(a, key)) return null
        val n = a.opt(key) as? Number ?: throw BadRequest("bad_args")
        val d = n.toDouble()
        if (!d.isFinite() || d < 0 || d > MAX_START_MS) throw BadRequest("bad_args")
        return d.toLong()
    }

    private fun absent(a: JSONObject, key: String) = !a.has(key) || a.isNull(key)

    private fun ok(id: String, result: Any) = JSONObject().put("id", id).put("ok", true).put("result", result).toString()

    private fun error(id: String?, code: String) = JSONObject().put("id", id ?: JSONObject.NULL).put("ok", false).put("error", code).toString()

    private companion object {
        const val API_VERSION = 1
        val TOP_KEYS = setOf("id", "method", "args")
        val ID = Regex(ID_PATTERN)
        val REQUEST_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        val TRACK = Regex("^[A-Za-z0-9_-]{1,32}$")
    }
}
