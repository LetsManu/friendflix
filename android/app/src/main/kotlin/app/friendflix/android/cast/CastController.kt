// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import app.friendflix.android.player.FlowPrefs
import app.friendflix.android.player.ItemInfo
import app.friendflix.android.player.PlaybackReporter
import app.friendflix.android.player.Position
import app.friendflix.android.player.ReportSession
import app.friendflix.android.player.Segment
import app.friendflix.android.player.StillWatching
import app.friendflix.android.player.SubtitleStyle
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executor

/** The server side of casting (blocking; called on the controller's `io` executor). */
interface CastServer {
    /** `POST /api/cast/session` */
    fun session(body: JSONObject): TokenAnswer
    /** `DELETE /api/cast/session/:castId`, best effort */
    fun revoke(castId: String)
    /** `POST /api/playback/<kind>` for the cast token's play session, best effort */
    fun report(kind: PlaybackReporter.Kind, body: JSONObject)
    /** `GET /api/items/:id/next` (null: none, a film, or the request failed) */
    fun next(itemId: String): ItemInfo?
    /** the title's skip / credits segments the server offers */
    fun segments(itemId: String): List<Segment>
}

/** The Cast receiver as the controller drives it (main thread). The real one is [MediaThreeReceiver]. */
interface CastReceiver {
    /** FriendFlix's own receiver (CAST_RECEIVER_APP_ID) is the running Cast app; false = Default Media Receiver */
    val custom: Boolean
    /** loads the token's media as the server answered it (URLs, subtitles, metadata unchanged) */
    fun load(info: CastInfo, subIndex: Int?, autoplay: Boolean)
    /** the next title into the receiver's queue after the playing one; false: refused */
    fun queue(info: CastInfo, autoplay: Boolean): Boolean
    fun dequeue(castId: String)
    /** a message on the own receiver's private channel (no-op with the Default Media Receiver) */
    fun send(msg: JSONObject)
    /** ends the Cast session (the receiver app stops) */
    fun end()
}

/** What the receiver plays ([castId] = the token of its current media, null = other or unknown media). */
data class ReceiverState(
    val castId: String?,
    val loaded: Boolean,
    val playing: Boolean,
    val paused: Boolean,
    val positionMs: Long,
    val durationMs: Long,
    val idle: Boolean,
)

/** Why the receiver went idle (Cast `MediaStatus.IDLE_REASON_*`). */
enum class IdleReason { FINISHED, CANCELLED, INTERRUPTED, ERROR, UNKNOWN }

/** The player screen while it hands a title to the TV and takes it back. */
interface CastHost {
    /** the local session ends here (its `stop` report goes out before the token request) and local playback stops */
    fun stopLocal()
    /** the receiver took the title: the screen becomes its remote */
    fun onCasting(itemId: String)
    /** the receiver moved on to the queued next episode */
    fun onTitle(item: ItemInfo)
    /** a token request was refused ([answer]) or the receiver did not load it (null) */
    fun onFailed(answer: TokenAnswer?)
    /**
     * casting is over: local playback goes on at [positionMs] (null = unknown, a title picked for the TV that never played there:
     * the server's resume point); [play] = it was playing; [ended] = the title finished on the TV
     */
    fun onReturn(itemId: String, positionMs: Long?, play: Boolean, ended: Boolean)
    /** the own receiver's TV texts in the app's language (engine.ts `receiverStrings`) */
    fun receiverStrings(): JSONObject
}

/** What the player hands over when casting starts (Player.svelte `handoff`). */
data class CastStart(
    val itemId: String,
    val positionMs: Long,
    val audioIndex: Int?,
    val subIndex: Int?,
    /** the viewer's quality pick (null = automatic), engine `maxBitrate` */
    val maxBitrate: Long?,
    /** the saved quality default (web `firstInfoBody(prefs).maxBitrate`), used for queued / renewed tokens without a pick */
    val prefsBitrate: Long?,
    val isEpisode: Boolean,
    val prefs: FlowPrefs,
    /** a native download: the receiver cannot reach local files, it is never cast */
    val offline: Boolean,
    val segments: List<Segment> = emptyList(),
    /** the profile's subtitle style for the own receiver (web prefs `subtitleStyle`, defaults merged in) */
    val subtitleStyle: JSONObject? = null,
)

/**
 * Chromecast from the native player through the server's cast token flow, with the web cast engine's rules (web/src/lib/cast/engine.ts,
 * Chromecast part; Player.svelte `startCast`):
 * - start: the local session's `stop` first ([CastHost.stopLocal]), then `POST /api/cast/session` ([CastBodies.token]), then the token
 *   is loaded on the receiver as answered. From then on only this controller reports (`start` once the receiver plays, `progress` every
 *   [PROGRESS_MS] and on pause changes / seeks, `stop` at the end), for the cast token's play session; the own receiver also reports
 *   with its report token, exactly as with the web sender.
 * - the next episode goes into the receiver's queue once the end is within [QUEUE_WITHIN_MS] and autoplay is allowed for the expected
 *   end, with its own token (`next: true` after the playing token, [CastBodies.queue]); the receiver moves on by itself. The next-token
 *   gate, the predecessor overlap and the drain window are the server's: nothing here asks around them.
 * - a token that expires within [RENEW_BEFORE_MS] is renewed at the position (stop, revoke, new token, load)
 * - every ended token is stopped (reported) before it is revoked; one cast token plays at a time
 * - session end / interrupted media: the position goes back to the device ([CastHost.onReturn]); closing the player stops the cast
 *   ([stop], the web's pagehide)
 * State is confined to the main thread; server calls run on [io] (the same ordered thread as the local reports, so the local `stop`
 * always leaves before the token request) and their results come back through [main].
 */
class CastController(
    private val server: CastServer,
    private val receiver: CastReceiver,
    private val host: CastHost,
    private val still: StillWatching,
    private val io: Executor,
    private val main: Executor,
    private val now: () -> Long,
    /** runs the block after the delay on the main thread; returns its cancel */
    private val schedule: (Long, () -> Unit) -> (() -> Unit),
) {
    private class Queued(val ci: CastInfo, val item: ItemInfo, val ask: Boolean)

    private class Live(start: CastStart) {
        var itemId = start.itemId
        var isEpisode = start.isEpisode
        var positionMs = start.positionMs
        var durationMs = 0L
        var paused = false
        var ci: CastInfo? = null
        var started = false
        var busy = true
        var hold = false
        var lastPaused: Boolean? = null
        var audioIndex = start.audioIndex
        var subIndex = start.subIndex
        val maxBitrate = start.maxBitrate
        val prefsBitrate = start.prefsBitrate
        val prefs = start.prefs
        var segs = start.segments
        var queued: Queued? = null
        var queueAsked = false
        var noAuto: String? = null
        var lastLoop = 0L
        var cancel: (() -> Unit)? = null
        /** no token of this session was loaded yet (a refused first request plays on locally) */
        var firstStart = true
        val subtitleStyle = start.subtitleStyle
        /** a title picked for the TV ([playOnTv]) whose token was not loaded yet: no position of it is known */
        var fresh = false
        /** the position to hand back */
        val returnAt: Long? get() = if (fresh) null else positionMs
    }

    private var cur: Live? = null
    /** the delayed session end after a title finished on the TV (cancel); [stop] ends the session at once instead */
    private var pendingEnd: (() -> Unit)? = null
    /** bumped by every token switch and session end: an older async step that sees another value gives up */
    private var seq = 0

    /** a cast runs (or is being started) */
    val casting: Boolean get() = cur != null

    /** the item the receiver plays */
    val itemId: String? get() = cur?.itemId

    /**
     * Sleep timer "after this episode" (engine.ts `mayAutoplay` sleepAfterEpisode): nothing is queued after the playing title, an
     * episode already queued is taken off again, so the TV stops at the end. Switched off, the next episode is queued again.
     */
    var sleepAfterEpisode = false
        set(v) {
            if (field == v) return
            field = v
            val s = cur ?: return
            if (v) dequeue(s)
            s.queueAsked = false
            if (!v) atPosition(s)
        }

    /**
     * Local playback → receiver. False when nothing can be cast (a download, or already casting); true once the hand-over started
     * (its outcome comes through [CastHost]).
     */
    fun start(start: CastStart): Boolean {
        if (start.offline || cur != null) return false
        pendingEnd?.invoke(); pendingEnd = null // a new cast on the still-connected TV
        val s = Live(start)
        cur = s
        val my = ++seq
        host.stopLocal()
        val body = CastBodies.token(s.itemId, s.positionMs, s.audioIndex, s.maxBitrate, receiver.custom)
        io.execute {
            val a = server.session(body)
            main.execute { loaded(s, my, a) }
        }
        return true
    }

    /**
     * Another title on the TV while casting (the Episodes panel; engine.ts `playOnTv` → `swap` fresh): the queue is cleared, the
     * playing token's `stop` reported and the token revoked, then a token for [item] at the server's resume point with the default
     * audio and no subtitle is loaded. False when no cast runs.
     */
    fun playOnTv(item: ItemInfo): Boolean {
        val s = cur ?: return false
        val my = ++seq
        s.cancel?.invoke(); s.cancel = null
        dequeue(s)
        stopReport(s)
        val old = s.ci
        s.ci = null; s.busy = true; s.started = false; s.lastPaused = null; s.hold = false
        s.queueAsked = false; s.noAuto = null
        s.itemId = item.id; s.isEpisode = item.type == "Episode"
        s.audioIndex = null; s.subIndex = null; s.segs = emptyList()
        s.positionMs = 0; s.durationMs = 0; s.paused = false; s.fresh = true
        host.onTitle(item)
        val body = CastBodies.token(item.id, null, null, s.maxBitrate ?: s.prefsBitrate, receiver.custom)
        io.execute {
            if (old != null) server.revoke(old.castId) // after the stop report (same ordered thread)
            val a = server.session(body)
            main.execute { loaded(s, my, a) }
        }
        loadSegs(s)
        return true
    }

    private fun loaded(s: Live, my: Int, a: TokenAnswer) {
        if (cur !== s || my != seq) { if (a is TokenAnswer.Ok) revoke(a.info); return }
        s.busy = false
        if (a !is TokenAnswer.Ok) {
            // the receiver did not get it: local playback at the position (Player.svelte startCast catch)
            val first = s.firstStart
            close(s)
            receiver.end()
            host.onFailed(a)
            host.onReturn(s.itemId, s.returnAt, play = first || !s.paused, ended = false)
            return
        }
        val ci = a.info
        s.ci = ci
        s.fresh = false
        s.firstStart = false
        s.started = false
        s.lastPaused = null
        s.lastLoop = now()
        ci.runtimeTicks?.let { s.durationMs = it / TICKS_PER_MS }
        receiver.load(ci, s.subIndex, autoplay = !s.hold)
        sendReport(ci)
        tvUi(s)
        tvSync(s)
        host.onCasting(s.itemId)
    }

    /** the receiver refused the loaded media (load error) */
    fun onLoadFailed() {
        val s = cur ?: return
        val ci = s.ci ?: return
        stopReport(s)
        revoke(ci)
        s.ci = null
        close(s)
        receiver.end()
        host.onFailed(null)
        host.onReturn(s.itemId, s.positionMs, play = true, ended = false)
    }

    /** A receiver status update (engine.ts `tick`). */
    fun onReceiver(st: ReceiverState) {
        val s = cur ?: return
        val ci = s.ci ?: return
        if (s.busy) return
        val q = s.queued
        if (st.loaded && q != null && st.castId == q.ci.castId && st.castId != ci.castId) advanced(s)
        else if (st.loaded && st.castId != null && st.castId != ci.castId) return // other media: not ours
        val live = s.ci ?: return
        val begins = st.loaded && !s.started && (st.playing || (s.hold && st.paused))
        // an idle receiver's time is no position (it is reset around the end): the end check needs the last real one
        if (st.loaded && !st.idle) {
            s.positionMs = st.positionMs
            if (st.durationMs > 0) s.durationMs = st.durationMs
            s.paused = st.paused
        }
        if (!st.loaded) return
        if (begins) { s.started = true; s.hold = false; report(s, PlaybackReporter.Kind.START, live) }
        else if (s.started && s.lastPaused != null && s.lastPaused != st.paused) report(s, PlaybackReporter.Kind.PROGRESS, live)
        s.lastPaused = st.paused
        atPosition(s)
    }

    /** a seek on the receiver (from the remote controls) */
    fun onSeeked(positionMs: Long) {
        val s = cur ?: return
        val ci = s.ci ?: return
        if (s.busy) return
        s.positionMs = positionMs
        if (s.started) report(s, PlaybackReporter.Kind.PROGRESS, ci)
    }

    /** About once a second: the [PROGRESS_MS] progress report and the token renewal (engine.ts `arm`). */
    fun tick() {
        val s = cur ?: return
        val ci = s.ci ?: return
        if (s.busy) return
        val t = now()
        if (t - s.lastLoop < PROGRESS_MS) return
        s.lastLoop = t
        if (s.started) report(s, PlaybackReporter.Kind.PROGRESS, ci)
        if (ci.expiresAt - t < RENEW_BEFORE_MS) renew(s)
    }

    /** The receiver's media ended (engine.ts `onEvent` media-end); [castId] = the token that was loaded (null = unknown). */
    fun onMediaEnd(reason: IdleReason, castId: String? = null) {
        val s = cur ?: return
        val ci = s.ci ?: return
        if (s.busy) return
        if (castId != null && castId != ci.castId) return // the replaced media of a renewal / switch: not the end of ours
        // FINISHED is the end; CANCELLED / INTERRUPTED never is; otherwise the position decides (idle well before the end is an error)
        val finished = reason == IdleReason.FINISHED ||
            (reason != IdleReason.CANCELLED && reason != IdleReason.INTERRUPTED && s.durationMs > 0 && s.positionMs >= s.durationMs - END_SLACK_MS)
        if (finished && s.queued != null) {
            // the receiver moves on to the queued episode by itself; it is loaded from here if it did not after ADVANCE_WAIT_MS
            advanced(s)
            val next = s.ci!!
            s.cancel = schedule(ADVANCE_WAIT_MS) { if (cur === s && s.ci === next && !s.started) receiver.load(next, null, autoplay = !s.hold) }
            return
        }
        if (finished) s.positionMs = if (s.durationMs > 0) s.durationMs else s.positionMs
        stopReport(s)
        revoke(ci)
        s.ci = null
        close(s)
        if (finished) {
            // the bar stays a moment on the TV (engine ENDED_HIDE_MS), then the session ends
            pendingEnd = schedule(ENDED_HIDE_MS) { pendingEnd = null; if (cur == null) receiver.end() }
            host.onReturn(s.itemId, s.positionMs, play = false, ended = true)
        } else {
            receiver.end()
            host.onReturn(s.itemId, s.positionMs, play = !s.paused, ended = false)
        }
    }

    /** The Cast session ended (stopped from the Cast dialog, another sender, connection lost): back to the device at its position. */
    fun onSessionEnded() {
        val s = cur ?: return
        val ci = s.ci
        dequeue(s)
        stopReport(s)
        if (ci != null) revoke(ci)
        s.ci = null
        close(s)
        host.onReturn(s.itemId, s.returnAt, play = !s.paused, ended = false)
    }

    /** A message from the own receiver (its remote): input on the TV, a cancelled countdown. */
    fun onReceiverMessage(m: JSONObject) {
        val s = cur ?: return
        when (m.optString("t")) {
            "interaction" -> still.noteInteraction()
            "cancel" -> {
                val q = s.queued ?: return
                still.noteInteraction()
                s.noAuto = q.item.id
                dequeue(s)
                tvSync(s)
            }
        }
    }

    /** The player closes while casting (the web's pagehide): queued token revoked, stop reported, token revoked, receiver stopped. */
    fun stop() {
        val s = cur ?: run {
            // a title just finished on the TV and the player closes before its delayed end: the session ends now
            val p = pendingEnd ?: return
            pendingEnd = null
            p()
            receiver.end()
            return
        }
        dequeue(s)
        stopReport(s)
        s.ci?.let(::revoke)
        s.ci = null
        close(s)
        receiver.end()
    }

    // ---- internals ----

    private fun atPosition(s: Live) {
        if (cur !== s || s.ci == null || s.busy || !s.isEpisode || s.durationMs <= 0) return
        if (!s.queueAsked && s.durationMs - s.positionMs <= QUEUE_WITHIN_MS) { s.queueAsked = true; prequeue(s) }
    }

    /** engine.ts `prequeue`: the next episode into the receiver's queue (own token, `next: true` after the playing one) */
    private fun prequeue(s: Live) {
        val ci = s.ci ?: return
        val endAt = now() + (s.durationMs - s.positionMs).coerceAtLeast(0)
        val ask = still.shouldAsk(s.prefs, endAt)
        val tv = receiver.custom
        // the own receiver asks "still watching?" itself (the queued episode waits paused): only that does not block it
        if (sleepAfterEpisode || !s.prefs.autoplayNext || (ask && !tv)) return
        val my = seq
        val itemId = s.itemId
        val bitrate = s.maxBitrate ?: s.prefsBitrate
        val stale = { cur !== s || my != seq || s.busy || s.ci == null || sleepAfterEpisode }
        io.execute {
            val next = server.next(itemId) ?: return@execute
            main.execute {
                // stale or cancelled meanwhile: no token is minted (engine.ts prequeue checks before the request)
                if (stale() || s.noAuto == next.id) return@execute
                io.execute {
                    val a = server.session(CastBodies.queue(next.id, bitrate, ci.castId, tv))
                    main.execute {
                        if (a !is TokenAnswer.Ok) return@execute
                        if (stale() || s.noAuto == next.id) { revoke(a.info); return@execute }
                        if (!receiver.queue(a.info, autoplay = if (tv) !ask else true)) { revoke(a.info); return@execute }
                        s.queued = Queued(a.info, next, ask && tv)
                        sendReport(a.info)
                        tvSync(s)
                    }
                }
            }
        }
    }

    /** the receiver plays the queued episode: the ended one's stop is reported (at its end) and its token revoked */
    private fun advanced(s: Live) {
        val q = s.queued ?: return
        val old = s.ci
        s.queued = null
        s.cancel?.invoke(); s.cancel = null
        if (s.durationMs > 0) s.positionMs = s.durationMs
        stopReport(s)
        if (old != null) revoke(old)
        still.noteAutoplay() // the receiver moved on alone: an autoplay all the same (the chain counts)
        still.opened()
        seq++
        s.ci = q.ci; s.started = false; s.lastPaused = null; s.hold = q.ask
        s.audioIndex = null; s.subIndex = null; s.noAuto = null; s.queueAsked = false
        s.itemId = q.item.id; s.isEpisode = q.item.type == "Episode"
        s.positionMs = q.ci.startTime * 1000; s.durationMs = (q.ci.runtimeTicks ?: 0) / TICKS_PER_MS; s.paused = false
        s.segs = emptyList()
        host.onTitle(q.item)
        loadSegs(s)
        tvSync(s)
    }

    /** a new token for the same title at the position (engine.ts `swap`, not fresh); a paused TV stays paused */
    private fun renew(s: Live) {
        val old = s.ci ?: return
        val my = ++seq
        dequeue(s)
        s.queueAsked = false
        stopReport(s)
        s.ci = null; s.busy = true; s.lastPaused = null; s.hold = s.paused
        val body = CastBodies.token(s.itemId, s.positionMs, s.audioIndex, s.maxBitrate ?: s.prefsBitrate, receiver.custom)
        io.execute {
            server.revoke(old.castId) // after the stop report (same ordered thread): the server counts the stream until then
            val a = server.session(body)
            main.execute { loaded(s, my, a) }
        }
    }

    private fun dequeue(s: Live) {
        val q = s.queued ?: return
        s.queued = null
        receiver.dequeue(q.ci.castId)
        revoke(q.ci)
        tvSync(s)
    }

    private fun loadSegs(s: Live) {
        if (!receiver.custom) return
        val id = s.itemId
        io.execute {
            val segs = server.segments(id)
            main.execute { if (cur === s && s.itemId == id) { s.segs = segs; tvSync(s) } }
        }
    }

    private fun report(s: Live, kind: PlaybackReporter.Kind, ci: CastInfo) {
        val body = PlaybackReporter.body(ReportSession(s.itemId, ci.playSessionId, ci.mediaSourceId, s.audioIndex, direct = false), Position(s.positionMs, s.paused))
        io.execute { server.report(kind, body) }
    }

    /** the owed `stop` for the live token */
    private fun stopReport(s: Live) {
        val ci = s.ci ?: return
        if (!s.started) return
        s.started = false
        report(s, PlaybackReporter.Kind.STOP, ci)
    }

    private fun revoke(ci: CastInfo) { io.execute { server.revoke(ci.castId) } }

    private fun close(s: Live) {
        if (cur !== s) return
        cur = null
        seq++
        s.cancel?.invoke(); s.cancel = null
    }

    /** the own receiver's report token of a loaded / queued token (lib/cast.ts `sendReport`) */
    private fun sendReport(ci: CastInfo) {
        val rt = ci.report ?: return
        if (receiver.custom) receiver.send(JSONObject().put("t", "tok").put("castId", ci.castId).put("rt", rt))
    }

    /** own receiver: texts and countdown length (engine.ts `tvUi`) */
    private fun tvUi(s: Live) {
        if (cur !== s || !receiver.custom) return
        receiver.send(JSONObject().put("t", "ui").put("strings", host.receiverStrings()).put("sub", s.subtitleStyle ?: SubtitleStyle().toJson())
            .put("countdown", COUNTDOWN_SECONDS))
    }

    /** own receiver: segments and the queued next episode of the playing token (engine.ts `tvSync`) */
    private fun tvSync(s: Live) {
        val ci = s.ci ?: return
        if (cur !== s || !receiver.custom) return
        val segs = JSONArray()
        for (x in s.segs) segs.put(JSONObject().put("type", x.type).put("start", x.startSec).put("end", x.endSec))
        val q = s.queued
        val next: Any = if (q == null) JSONObject.NULL else JSONObject()
            .put("castId", q.ci.castId).put("label", label(q.item)).put("auto", s.noAuto != q.item.id).put("ask", q.ask)
        receiver.send(JSONObject().put("t", "item").put("castId", ci.castId).put("episode", s.isEpisode).put("segs", segs).put("next", next))
    }

    /** "S1:E2 · Name" like remoteview.ts `episodeLabel` (the episode code without the UI language's letter) */
    private fun label(i: ItemInfo): String {
        val code = if (i.season != null && i.episode != null) "S${i.season}:E${i.episode}" else ""
        return listOf(code, i.name).filter { it.isNotEmpty() }.joinToString(" · ")
    }

    companion object {
        /** engine.ts PROGRESS_MS */
        const val PROGRESS_MS = 10_000L
        /** engine.ts RENEW_BEFORE_MS */
        const val RENEW_BEFORE_MS = 10 * 60_000L
        /** engine.ts QUEUE_WITHIN_S (the queued token's idle lifetime on the server is 45 min) */
        const val QUEUE_WITHIN_MS = 40 * 60_000L
        /** engine.ts ADVANCE_WAIT_MS */
        const val ADVANCE_WAIT_MS = 20_000L
        /** engine.ts ENDED_HIDE_MS */
        const val ENDED_HIDE_MS = 5_000L
        /** engine.ts: idle within the last 20 s counts as the end */
        const val END_SLACK_MS = 20_000L
        /** nextup.ts COUNTDOWN_SECONDS */
        const val COUNTDOWN_SECONDS = 10
        private const val TICKS_PER_MS = 10_000L


        /** The cast button is offered: a stream (never a download), casting enabled on the server, a Cast device on the network. */
        fun castable(offline: Boolean, enabled: Boolean, devices: Boolean) = !offline && enabled && devices
    }
}
