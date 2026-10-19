// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.bridge

/**
 * Messages between the web UI and the app. Everything here is plain data: the bridge validates before it builds one of these,
 * so an implementation can trust the shape (ids match [ID_PATTERN], numbers are in range).
 */

/** Play a movie / episode in the native player. Task 8 implements [PlayerLauncher]. */
data class PlayRequest(
    val itemId: String,
    val profileId: String,
    /** resume position in milliseconds, 0..[MAX_START_MS]; null = from the start (or the server's resume point) */
    val startMs: Long?,
    val mediaSourceId: String?,
    /** preferred audio language / track id (`[A-Za-z0-9_-]{1,32}`) */
    val audio: String?,
    /** preferred subtitle language / track id (same shape as [audio]) */
    val subtitle: String?,
)

/** Hand over a download whose licence the web UI already created on the server. Task 6 implements [DownloadSink]. */
data class DownloadRequest(val licenseId: String, val itemId: String, val profileId: String)

/**
 * One download as the web UI shows it.
 * [state] is one of queued | preparing | downloading | paused | done | error | expired (the same names the web UI already uses);
 * [progress] is 0.0..1.0; [bytes] the bytes on disk; [expiresAt] epoch milliseconds; [error] why an `error` download stopped
 * (`noSpace` | `io` | `prepFailed`, the web UI's existing message codes), else null (the key is then left out).
 */
data class DownloadEntry(
    val licenseId: String,
    val itemId: String,
    val state: String,
    val progress: Double,
    val bytes: Long,
    val expiresAt: Long,
    val error: String? = null,
)

/**
 * Returns true only when playback really started in the native player; false makes the web UI play the title itself.
 * Must be idempotent per request: if the answer is slow the web UI gives up after a timeout, falls back to its own player and may
 * ask again. A repeated identical request must not start a second player.
 */
interface PlayerLauncher {
    fun launch(req: PlayRequest): Boolean
}

/**
 * Returns true only when the download was accepted; false makes the web UI download it in the page instead.
 * [enqueue] must be idempotent per licenseId (accepting an already known licence is true, no duplicate): after a timeout the web UI
 * asks [list] and may re-send, and adopts into the browser only licences the app does not list.
 */
interface DownloadSink {
    fun enqueue(req: DownloadRequest): Boolean
    fun list(): List<DownloadEntry>
    fun delete(licenseId: String): Boolean
}

/** What this build can do natively right now; the web UI only uses a native path whose flag is true. */
data class Capabilities(val play: Boolean, val download: Boolean, val cast: Boolean)

/** Where native code can send a JSON string back to the page (the main frame's reply channel). */
fun interface ReplySink {
    fun post(json: String)
}

/** Placeholder until the native player exists: every request is declined, so the web UI plays in the page. */
object NoPlayerLauncher : PlayerLauncher {
    override fun launch(req: PlayRequest): Boolean = false
}

/** Placeholder until native downloads exist: every request is declined, so the web UI downloads in the page. */
object NoDownloadSink : DownloadSink {
    override fun enqueue(req: DownloadRequest): Boolean = false
    override fun list(): List<DownloadEntry> = emptyList()
    override fun delete(licenseId: String): Boolean = false
}

const val ID_PATTERN = "^[A-Za-z0-9-]{1,64}$"
const val MAX_START_MS = 7L * 24 * 60 * 60 * 1000
const val MAX_MESSAGE_CHARS = 4096
