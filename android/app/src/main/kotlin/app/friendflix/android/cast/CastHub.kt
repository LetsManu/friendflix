// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.media3.common.util.UnstableApi
import androidx.mediarouter.media.MediaRouteSelector
import app.friendflix.android.downloads.Downloads
import app.friendflix.android.offline.Offline
import app.friendflix.android.player.FlowPrefs
import app.friendflix.android.player.ItemInfo
import app.friendflix.android.player.PlayerApi
import app.friendflix.android.player.Players
import app.friendflix.android.player.StillWatching
import com.google.android.gms.cast.framework.CastContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executor

/** The receiver side the hub drives: a [CastReceiver] plus the TV's name, the status mirror and its release ([MediaThreeReceiver]). */
interface CastLink : CastReceiver {
    val connected: Boolean
    /** a Cast session is being connected (a TV was picked, not connected yet) */
    val connecting: Boolean get() = false
    /** the TV's name for the "playing on" line (shown, never logged) */
    val deviceName: String?
    /** mirrors the receiver into the controller (about once a second while casting) */
    fun publish()
    fun release()
    /** the bar's play / pause: toggles the receiver's player */
    fun togglePause() {}
}

/**
 * The cast of this process, independent of any player screen: it owns the [CastController] and the receiver link, forwards the
 * receiver's events, mirrors the cast as a [CastSnapshot] and ticks the controller about once a second while a cast runs (progress
 * reports, token renewal, the queue). A player screen only attaches as the [CastHost] ([attach]) and lets go again ([detach]):
 * closing it neither stops nor reports anything (the web's pagehide). Only [stop] ends a cast (Stop casting, sign-out, profile switch).
 * A cast a restarted app finds on the receiver is adopted once the receiver reports it ([CastController.resume]). Main thread only.
 */
class CastHubCore(
    server: CastServer,
    linkFactory: (MediaThreeReceiver.Events) -> CastLink,
    private val still: StillWatching,
    private val io: Executor,
    private val main: Executor,
    now: () -> Long,
    private val schedule: (Long, () -> Unit) -> (() -> Unit),
    /** the own receiver's TV texts when no player screen is attached */
    private val strings: () -> JSONObject,
    hints: CastHints = CastHints.None,
    adoptDefaults: () -> Pair<FlowPrefs, Long?> = { FlowPrefs() to null },
    private val snapshots: MutableStateFlow<CastSnapshot?> = MutableStateFlow(null),
) {
    private var host: CastHost? = null
    private var pumping = false
    /** the receiver media a resume was tried for (one try per media) */
    private var resumeTried: String? = null
    /** the profile the cast belongs to (null: unknown) */
    private var profile: String? = null
    /** a live channel waiting for the viewer to pick a TV ([castLive]): its id and answer, and the cancel of its wait */
    private var pendingLive: Pair<String, (Boolean) -> Unit>? = null
    private var cancelPick: (() -> Unit)? = null

    /** what the attached screen is told; nothing while detached (the cast runs on without it) */
    private val delegate = object : CastHost {
        override fun stopLocal() { host?.stopLocal() }
        override fun onCasting(itemId: String) { host?.onCasting(itemId) }
        override fun onTitle(item: ItemInfo) { host?.onTitle(item) }
        override fun onFailed(answer: TokenAnswer?) { host?.onFailed(answer) }
        override fun playingLocally(): Boolean = host?.playingLocally() ?: false
        override fun onReturn(itemId: String, positionMs: Long?, play: Boolean, ended: Boolean) { host?.onReturn(itemId, positionMs, play, ended) }
        override fun receiverStrings(): JSONObject = host?.receiverStrings() ?: strings()
        override fun onDevicePicked() { host?.onDevicePicked() }
    }

    private val events = object : MediaThreeReceiver.Events {
        override fun onSessionStarted() {
            // the viewer picked a TV for a live channel ([castLive]): the channel goes there, not a player screen's title
            val p = takeLive()
            if (p != null) startLive(p.first, p.second) else delegate.onDevicePicked()
        }
        override fun onSessionEnded() { controller.onSessionEnded(); refresh() }
        override fun onState(st: ReceiverState) {
            controller.onReceiver(st)
            if (!controller.active && st.loaded && !st.idle && st.castId != null && st.castId != resumeTried) {
                resumeTried = st.castId
                // a lookup that could not be answered (network, server) is tried again later, at most every RESUME_RETRY_MS (rate limit)
                link.current()?.let { m -> controller.resume(m.castId, m.contentUrl) { schedule(RESUME_RETRY_MS) { resumeTried = null; link.publish() } } }
            }
            if (!st.loaded) resumeTried = null
            refresh()
        }
        override fun onMediaEnd(reason: IdleReason, castId: String) { controller.onMediaEnd(reason, castId); refresh() }
        override fun onSeeked(positionMs: Long) { controller.onSeeked(positionMs); refresh() }
        override fun onLoadFailed() { controller.onLoadFailed(); refresh() }
        override fun onMessage(m: JSONObject) { controller.onReceiverMessage(m); refresh() }
    }

    val link: CastLink = linkFactory(events)
    val controller: CastController = CastController(
        server, link, delegate, still, io, main, now, schedule, changed = ::refresh, hints = hints, adoptDefaults = adoptDefaults,
    )

    val state: StateFlow<CastSnapshot?> get() = snapshots

    /** A player screen becomes the cast's host. The controller is the screen's to drive; `casting` tells whether it is the remote. */
    fun attach(h: CastHost): CastController {
        host = h
        return controller
    }

    /** The screen lets go (it closes): the cast goes on, nothing is stopped, reported or revoked. */
    fun detach(h: CastHost) {
        if (host === h) host = null
    }

    /** Ends the cast: the queued token revoked, stop reported, token revoked, the receiver's session ended. */
    fun stop() {
        controller.stop()
        refresh()
    }

    /** the profile a cast started or was found for */
    fun useProfile(id: String?) { profile = id }

    /** A request names the active profile: another one than the cast's ends it (the server revoked the device's casts on the switch). */
    fun noteProfile(id: String) {
        val p = profile
        if (controller.active) { if (p != null && p != id) stop() } else profile = id
    }

    /**
     * The shell's bridge `castLive` (spec §13): a live channel on the TV. With a connected TV it is loaded at once
     * ([CastController.startLive]); without one, [pickDevice] shows the device chooser and the channel goes to the TV the viewer
     * picks (within [PICK_WAIT_MS]). [done] once: true = the channel plays on the TV; false = no chooser, no TV picked in time, or
     * the watch request was refused. A newer request answers an older waiting one false.
     */
    fun castLive(channelId: String, pickDevice: () -> Boolean, done: (Boolean) -> Unit) {
        takeLive()?.second?.invoke(false)
        if (link.connected) { startLive(channelId, done); return }
        if (!pickDevice()) { done(false); return }
        val p = channelId to done
        pendingLive = p
        cancelPick = schedule(PICK_WAIT_MS) { pickTimedOut(p, extended = false) }
    }

    /** the wait ran out: a TV still connecting gets [CONNECT_WAIT_MS] more, once; else false */
    private fun pickTimedOut(p: Pair<String, (Boolean) -> Unit>, extended: Boolean) {
        if (pendingLive !== p) return
        if (!extended && link.connecting) { cancelPick = schedule(CONNECT_WAIT_MS) { pickTimedOut(p, extended = true) }; return }
        takeLive()?.second?.invoke(false)
    }

    /**
     * The device chooser closed. Without a TV being connected (checked after [DISMISS_GRACE_MS], the framework's state follows the
     * pick a moment later) nobody picked one: the waiting live channel answers false at once.
     */
    fun chooserClosed() {
        val p = pendingLive ?: return
        schedule(DISMISS_GRACE_MS) { if (pendingLive === p && !link.connected && !link.connecting) takeLive()?.second?.invoke(false) }
    }

    private fun takeLive(): Pair<String, (Boolean) -> Unit>? {
        val p = pendingLive ?: return null
        pendingLive = null
        cancelPick?.invoke()
        cancelPick = null
        return p
    }

    private fun startLive(channelId: String, done: (Boolean) -> Unit) {
        still.noteInteraction()
        controller.startLive(channelId) { ok -> done(ok); refresh() }
        refresh()
    }

    /**
     * The bar's Next: the queued next episode plays on the TV through the controller's title switch (the web `engine.next()`): the
     * skipped episode's stop is reported at its real position and its token revoked, then the next one starts. A viewer action (the
     * "still watching" chain starts over). False when no cast runs or no next episode is queued (nothing is changed).
     */
    fun next(): Boolean {
        if (!controller.casting) return false
        val id = controller.snapshot(link.deviceName.orEmpty())?.next?.itemId ?: return false
        still.noteInteraction()
        return controller.switchTo(id, null)
    }

    /** The item the player screen can open as the remote: the running cast's (null: none runs; a title that just ended is no cast). */
    fun openTarget(): String? = if (controller.casting) controller.itemId else null

    /** The bar's play / pause (a viewer action). */
    fun playPause() {
        if (!controller.active) return
        still.noteInteraction()
        link.togglePause()
    }

    /** The bar's Stop casting (a viewer action). */
    fun userStop() {
        still.noteInteraction()
        stop()
    }

    /** [stop]s, then calls [done] once the stop report and the revoke have left (or failed), at the latest after [REPORT_WAIT_MS]. */
    fun stopThen(done: () -> Unit) {
        stop()
        afterReports(done)
    }

    /** [noteProfile], and when that ended the cast the same wait as [stopThen]; else [done] right away. */
    fun noteProfileThen(id: String, done: () -> Unit) {
        val was = controller.active
        noteProfile(id)
        if (was && !controller.active) afterReports(done) else done()
    }

    /**
     * [done] (once) when everything queued on the report thread so far has run (the stop report and the revokes: they leave in order
     * on that one thread, still with the session cookie), or after [REPORT_WAIT_MS] when it is stuck.
     */
    fun afterReports(done: () -> Unit) {
        var fired = false
        var cancel: () -> Unit = {}
        val fire = {
            if (!fired) {
                fired = true
                cancel()
                done()
            }
        }
        cancel = schedule(REPORT_WAIT_MS, fire)
        io.execute { main.execute(fire) }
    }

    private fun refresh() {
        snapshots.value = controller.snapshot(link.deviceName.orEmpty())
        if (controller.active) pump()
    }

    private fun pump() {
        if (pumping) return
        pumping = true
        schedule(POLL_MS) {
            pumping = false
            if (controller.active) {
                link.publish()
                controller.tick()
                pump()
            }
        }
    }

    companion object {
        /** the receiver's position is mirrored and the controller ticked this often while casting */
        const val POLL_MS = 1_000L
        /** a resume lookup that failed is asked again no sooner (the server's lookup limit is 30 per minute) */
        const val RESUME_RETRY_MS = 30_000L
        /** how long an answer waits for the stop report and the revoke of an ended cast to leave */
        const val REPORT_WAIT_MS = 3_000L
        /** how long a live channel waits for the viewer to pick a TV in the chooser (web CAST_LIVE_TIMEOUT_MS covers this plus the bounds after it) */
        const val PICK_WAIT_MS = 40_000L
        /** the extra wait once, at [PICK_WAIT_MS], for a TV that is still connecting */
        const val CONNECT_WAIT_MS = 15_000L
        /** how long after the chooser closed the framework may take to report the picked TV as connecting */
        const val DISMISS_GRACE_MS = 1_000L
    }
}

/**
 * The process-wide [CastHubCore] (Task 29): started once ([init], by the shell and the player), it outlives every player screen.
 * Player screens use [attach] / [detach]; sign-out, a profile switch and the explicit Stop use [stop]; the bar reads [state].
 */
object CastHub {
    private const val TAG = "FFCastHub"

    private val snapshots = MutableStateFlow<CastSnapshot?>(null)
    private val readyFlow = MutableStateFlow(false)
    private val proxy = HubServer()
    @Volatile private var core: CastHubCore? = null
    private var starting = false
    @Volatile private var defaults: Pair<FlowPrefs, Long?> = FlowPrefs() to null
    @Volatile private var castContext: CastContext? = null

    /** the cast as the bar shows it (null: none) */
    val state: StateFlow<CastSnapshot?> = snapshots.asStateFlow()

    /** the Cast framework is up and the hub runs (false without Google Play services, or before [init] finished) */
    val ready: StateFlow<Boolean> = readyFlow.asStateFlow()

    /** the routes the Cast device chooser offers (the receiver app's); null until [ready] */
    val routeSelector: MediaRouteSelector? get() = castContext?.mergedSelector

    /** the receiver link (the Media3 player the remote controls drive, the device name); null until [ready] */
    val link: MediaThreeReceiver? get() = core?.link as? MediaThreeReceiver

    /** Starts the hub (idempotent, main thread): the Cast framework asynchronously; a cast still on the TV is picked up as it reports. */
    fun init(context: Context) {
        if (core != null || starting) return
        starting = true
        val app = context.applicationContext
        proxy.fallback = { defaultServer(app) }
        proxy.liveServer = { liveServer(app) }
        try {
            CastContext.getSharedInstance(app, ContextCompat.getMainExecutor(app))
                .addOnSuccessListener { ctx -> build(app, ctx) }
                .addOnFailureListener { e -> starting = false; Log.w(TAG, "cast unavailable ${e.javaClass.simpleName}") }
        } catch (e: RuntimeException) {
            starting = false
            Log.w(TAG, "cast unavailable ${e.javaClass.simpleName}")
        }
    }

    private fun build(app: Context, ctx: CastContext) {
        try {
            if (core == null) create(app, ctx)
        } finally {
            starting = false // a failed start (Media3 initialize) may be tried again
        }
    }

    // androidx.media3.cast.Cast is Media3's unstable API (like RemoteCastPlayer in MediaThreeReceiver)
    @OptIn(UnstableApi::class)
    private fun create(app: Context, ctx: CastContext) {
        val media3 = androidx.media3.cast.Cast.getSingletonInstance(app)
        if (media3.needsInitialization()) media3.initialize()
        // the running Cast app: FriendFlix's own receiver unless it is the Default Media Receiver (fixed for this process)
        val custom = CastConfig.customId(ctx.castOptions.receiverApplicationId).isNotEmpty()
        val handler = Players.castHandler
        core = CastHubCore(
            server = proxy,
            linkFactory = { ev -> MediaThreeReceiver(app, ctx, custom, ev) },
            still = Players.still,
            io = Players.reports,
            main = ContextCompat.getMainExecutor(app),
            now = System::currentTimeMillis,
            // app-scoped: the ticks, the delayed session end and the retries outlive every player screen
            schedule = { ms, block -> val r = Runnable(block); handler.postDelayed(r, ms); { handler.removeCallbacks(r) } },
            strings = { castReceiverStrings(app) },
            hints = PrefsCastHints(app),
            adoptDefaults = { defaults },
            snapshots = snapshots,
        )
        castContext = ctx
        readyFlow.value = true
    }

    /** A player screen is the cast's host; the controller it drives (null until [ready]). It is the remote while `casting`. */
    fun attach(host: CastHost): CastController? = core?.attach(host)

    /** The screen closes: the cast goes on (nothing is stopped, reported or revoked). */
    fun detach(host: CastHost) { core?.detach(host) }

    /** Ends the cast (Stop casting, sign-out, profile switch): queued token revoked, stop reported, token revoked, receiver stopped. */
    fun stop() {
        core?.stop()
        forgetAccount()
    }

    /**
     * The shell's bridge `castLive` ([CastHubCore.castLive]): [done] false when the hub is not up (no Google Play services, casting
     * off in the settings).
     */
    fun castLive(channelId: String, pickDevice: () -> Boolean, done: (Boolean) -> Unit) {
        val c = core ?: return done(false)
        c.castLive(channelId, pickDevice, done)
    }

    /** The device chooser of [castLive] closed ([CastHubCore.chooserClosed]). */
    fun chooserClosed() { core?.chooserClosed() }

    /** The bar's next episode ([CastHubCore.next]); false when none runs or none is queued. */
    fun next(): Boolean = core?.next() ?: false

    /** The item a player screen can open as the remote of the running cast, else null ([CastHubCore.openTarget]). */
    fun openTarget(): String? = core?.openTarget()

    /** The bar's play / pause. */
    fun playPause() { core?.playPause() }

    /** The bar's Stop casting: a viewer action, then [stop]. */
    fun userStop() {
        core?.userStop() ?: return
        forgetAccount()
    }

    /** Sign-out from the web UI: [stop], and [done] once the stop report and the revoke have left (bounded wait). */
    fun stopThen(done: () -> Unit) {
        val c = core
        if (c == null) { stop(); done(); return }
        c.stop()
        forgetAccount()
        c.afterReports(done)
    }

    /** Profile switch from the web UI: [noteProfile], with [done] after the reports when the cast ended with it. */
    fun noteProfileThen(profileId: String, done: () -> Unit) {
        core?.noteProfileThen(profileId, done) ?: done()
    }

    /** the account is gone: its prefs and profile go too. The server is dropped only after the stop calls (same ordered thread) */
    private fun forgetAccount() {
        defaults = FlowPrefs() to null
        core?.useProfile(null)
        val old = proxy.current.get()
        Players.reports.execute { proxy.current.compareAndSet(old, null) } // a server a screen set meanwhile survives
    }

    /** The server calls (and the profile) for the playing profile: the player screen's own, known once a stream started. */
    fun useServer(server: CastServer, profileId: String) {
        proxy.current.set(server)
        core?.useProfile(profileId)
    }

    /** The viewer's flow prefs and saved quality: what a cast found after a restart is queued with. */
    fun useDefaults(prefs: FlowPrefs, bitrate: Long?) { defaults = prefs to bitrate }

    /** A hand-over names the active profile: a cast of another profile ends. */
    fun noteProfile(profileId: String) { core?.noteProfile(profileId) }

    /** The cast endpoints of the player's profile, else of the last active profile (an app that restarted while casting). */
    private class HubServer : CastServer {
        val current = java.util.concurrent.atomic.AtomicReference<CastServer?>(null)
        @Volatile var fallback: () -> CastServer? = { null }

        private fun real(): CastServer? = current.get() ?: fallback()?.let { f -> if (current.compareAndSet(null, f)) f else current.get() }

        override fun session(body: JSONObject) = real()?.session(body) ?: TokenAnswer.Failed
        override fun revoke(castId: String) { real()?.revoke(castId) }
        override fun lookup(castId: String): CastLookup? = (real() ?: throw IOException("no server")).lookup(castId)
        override fun report(kind: app.friendflix.android.player.PlaybackReporter.Kind, body: JSONObject) { real()?.report(kind, body) }
        override fun next(itemId: String) = real()?.next(itemId)
        override fun segments(itemId: String) = real()?.segments(itemId) ?: emptyList()

        /** the live calls go out for the web session's active profile (the last one it named), not a player screen's */
        @Volatile var liveServer: () -> CastServer? = { null }
        override fun watchLive(channelId: String) = liveServer()?.watchLive(channelId)
        override fun stopLive(token: String) { liveServer()?.stopLive(token) }
    }

    /** The cast calls of the web session's active profile (the last one it named); off the main thread only. */
    private fun liveServer(app: Context): CastServer? {
        val profile = Offline.get(app).state.lastProfileId ?: return null
        val api = runBlocking { Downloads.get(app).api() } ?: return null
        core?.let { c -> Handler(Looper.getMainLooper()).post { if (!c.controller.casting) c.useProfile(profile) } }
        return CastServerApi(api, profile, PlayerApi(api, profile))
    }

    /** off the main thread only (the settings read suspends) */
    private fun defaultServer(app: Context): CastServer? {
        val profile = Offline.get(app).state.lastProfileId ?: return null
        val api = runBlocking { Downloads.get(app).api() } ?: return null
        core?.let { c -> Handler(Looper.getMainLooper()).post { c.useProfile(profile) } }
        val pa = PlayerApi(api, profile)
        // the profile's autoplay and "still watching" prefs for a cast found after a restart
        try { pa.prefs()?.let { p -> defaults = p.flow to p.quality.takeIf { it >= 300_000 } } } catch (_: IOException) { }
        return CastServerApi(api, profile, pa)
    }
}
