// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.json.JSONObject

/** Where the player is: position in ms and whether it is paused. */
data class Position(val ms: Long, val paused: Boolean)

/** The play session a stream belongs to (from `/api/playback/info`); [direct] = the direct-play URL is playing. */
data class ReportSession(val itemId: String, val playSessionId: String, val mediaSourceId: String, val audioIndex: Int?, val direct: Boolean)

/**
 * Online progress reporting with the web player's rules (web/src/lib/Player.svelte `send` / `onPlay` / `reportTick` / `bye`):
 * - the first play of a stream sends `start`; a later play sends `progress`; a play after the end starts again
 * - while started: `progress` every [INTERVAL_MS] ([tick] is called about once a second), on pause, after a seek, and when the app goes
 *   to the background (the web's visibilitychange; picture-in-picture keeps playing and only reports progress)
 * - `stop` at the end of the title, before a stream switch (audio track / quality) and when the player goes away, once
 * Bodies have the web's exact shape ([body]). [send] must keep the order of the calls (one background thread); errors are the
 * caller's to swallow, like the web's `.catch(() => undefined)`. Not thread-safe: call it from the player's thread.
 */
class PlaybackReporter(
    private val send: (Kind, JSONObject) -> Unit,
    private val now: () -> Long,
    private val position: () -> Position,
) {
    enum class Kind(val path: String) { START("start"), PROGRESS("progress"), STOP("stop") }

    private var session: ReportSession? = null
    private var started = false
    private var stopped = false
    private var lastSent = 0L

    /** A new stream (playback info answered): nothing is reported until it plays. */
    fun attach(s: ReportSession) {
        session = s
        started = false
        stopped = false
    }

    fun onPlay() {
        if (session == null) return
        if (stopped) { stopped = false; started = false }
        if (!started) { started = true; emit(Kind.START) } else emit(Kind.PROGRESS)
    }

    fun onPause() { if (session != null && !stopped) emit(Kind.PROGRESS) }

    fun onSeeked() { if (started) emit(Kind.PROGRESS) }

    /** Called about once a second: a progress report when the last one is [INTERVAL_MS] old. */
    fun tick() { if (started && !stopped && now() - lastSent >= INTERVAL_MS) emit(Kind.PROGRESS) }

    /** The app went to the background (or the screen locked): keep the resume position safe, keep playing. */
    fun onBackground() { if (started && !stopped) emit(Kind.PROGRESS) }

    fun onEnded() {
        if (session == null || stopped) return
        stopped = true
        emit(Kind.STOP)
    }

    /** Before the stream is replaced (another audio track or quality): the old play session ends here. */
    fun switchStream() {
        if (session != null && !stopped) emit(Kind.STOP)
        stopped = true
        session = null
    }

    /** The player goes away: `stop` once if the stream was reported as playing. */
    fun release() {
        if (started && !stopped) { stopped = true; emit(Kind.STOP) }
        session = null
    }

    private fun emit(kind: Kind) {
        val s = session ?: return
        lastSent = now()
        send(kind, body(s, position()))
    }

    companion object {
        const val INTERVAL_MS = 10_000L
        private const val TICKS_PER_MS = 10_000L

        /** `{itemId, playSessionId, mediaSourceId, positionTicks, isPaused, audioIndex?, playMethod}`, in the web player's key order. */
        fun body(s: ReportSession, p: Position): JSONObject = JSONObject().apply {
            put("itemId", s.itemId)
            put("playSessionId", s.playSessionId)
            put("mediaSourceId", s.mediaSourceId)
            put("positionTicks", p.ms.coerceAtLeast(0) * TICKS_PER_MS)
            put("isPaused", p.paused)
            s.audioIndex?.let { put("audioIndex", it) }
            put("playMethod", if (s.direct) "DirectPlay" else "Transcode")
        }
    }
}

/**
 * Offline playback (a native download): positions go to the device ([record] = `Offline.recordPosition`, synced later through the
 * SyncQueue), with the web OfflinePlayer's rules: at most every [PlaybackReporter.INTERVAL_MS] while playing, at once on pause / end /
 * background / close; nothing at position 0; `played` from 90 % on.
 */
class OfflineProgress(
    private val record: (positionMs: Long, played: Boolean) -> Unit,
    private val now: () -> Long,
    private val position: () -> Position,
    private val durationMs: () -> Long,
) {
    private var last = Long.MIN_VALUE / 2

    fun tick() = save(force = false)
    fun flush() = save(force = true)

    private fun save(force: Boolean) {
        val t = now()
        if (!force && t - last < PlaybackReporter.INTERVAL_MS) return
        val pos = position().ms
        if (pos <= 0) return
        last = t
        val dur = durationMs()
        record(pos, dur > 0 && pos.toDouble() / dur >= PLAYED_FRACTION)
    }

    companion object {
        const val PLAYED_FRACTION = 0.9
    }
}
