// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.annotation.OptIn
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import app.friendflix.android.R
import app.friendflix.android.cast.CastController
import app.friendflix.android.player.panels.EpisodesPanel
import app.friendflix.android.player.panels.EpisodesSource
import app.friendflix.android.player.panels.MoreActions
import app.friendflix.android.player.panels.MorePanel
import app.friendflix.android.player.panels.MoreState
import app.friendflix.android.player.panels.PlayerPanel
import app.friendflix.android.player.panels.TracksActions
import app.friendflix.android.player.panels.TracksPanel
import app.friendflix.android.player.panels.TracksState

/**
 * The Cast situation for the bar: the Cast framework is attached ([ready]), the server offers casting ([enabled]), a device is
 * on the network ([devices]), a cast runs ([casting]), a download plays ([offline]).
 */
data class CastUi(val ready: Boolean, val enabled: Boolean, val devices: Boolean, val casting: Boolean, val offline: Boolean) {
    /** the Chromecast button and the More row: for a castable stream with a device around, and always while a cast runs */
    val show: Boolean get() = ready && (casting || CastController.castable(offline, enabled, devices))
}

/**
 * The player bar's own controls (web Player.svelte bar), kept out of [PlayerActivity]: the panel host with the Tracks and More
 * panels, the speed (badge on More), the sleep timer (dot on More, checked by the activity's tick), lock controls, the quality
 * chip and the Chromecast button / *Play on TV* row. The activity supplies the playback side through [Host].
 */
@OptIn(UnstableApi::class)
class PlayerControls(
    private val activity: ComponentActivity,
    private val view: PlayerView,
    /** the local player (speed applies here, never to the TV) */
    private val local: Player,
    private val host: Host,
    now: () -> Long = SystemClock::elapsedRealtime,
) {
    interface Host {
        /** the player the screen drives: the cast session's while casting */
        fun active(): Player
        fun casting(): Boolean
        fun offline(): Boolean
        fun inPip(): Boolean
        fun flash(text: String, ms: Long)
        fun pipSupported(): Boolean
        fun enterPip()
        /** pauses what plays: the local player, or the TV while casting */
        fun pauseActive()
        /** the Tracks panel's state, or null when nothing plays yet */
        fun tracks(): TracksState?
        val tracksActions: TracksActions
        /** the quality rungs offered, or null when quality is not offered (offline, casting, no stream) */
        fun qualities(): List<Pair<String, Long>>?
        fun quality(): Long
        fun changeQuality(bps: Long)
        /** what the Episodes panel needs, or null when it is not offered (no episode of a series, a download, nothing loaded) */
        fun episodes(): EpisodesSource?
        /** plays another title in this player, or on the TV while casting; resets the per-title state ([newTitle], via [TitleSwitch]) */
        fun playItem(id: String)
    }

    val panel = PlayerPanel(activity.findViewById(R.id.player_panel_host))
    val sleep = SleepTimer(now)
    /** the Episodes panel's seasons and episodes, kept while this player lives */
    val episodesCache = EpisodesPanel.Cache()
    val chip = QualityChip(view.findViewById(R.id.player_quality_chip)) { host.flash(it, REASON_MS) }

    var speed = 1f
        private set
    var locked = false
        private set

    private var sleepMinutes = 0
    private var cast = CastUi(ready = false, enabled = false, devices = false, casting = false, offline = false)
    private val handler = Handler(Looper.getMainLooper())

    private val moreBadge: TextView = view.findViewById(R.id.player_more_badge)
    private val sleepDot: View = view.findViewById(R.id.player_more_dot)
    private val castButton: View = view.findViewById(R.id.player_cast)
    private val episodesButton: View = view.findViewById(R.id.player_episodes)
    private val lockOverlay: View = activity.findViewById(R.id.player_lock)
    private val lockIcon: View = activity.findViewById(R.id.player_lock_icon)

    /** Back while locked only says how to unlock (enabled only while locked; the player stays) */
    private val lockedBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() { host.flash(activity.getString(R.string.player_lock_hold), FLASH_MS) }
    }

    init {
        activity.onBackPressedDispatcher.addCallback(activity, panel.back)
        activity.onBackPressedDispatcher.addCallback(activity, lockedBack)
        view.findViewById<View>(R.id.player_more).setOnClickListener { openMore() }
        view.findViewById<View>(R.id.player_tracks).setOnClickListener { openTracks() }
        episodesButton.setOnClickListener { openEpisodes() }
        setUpLock()
        // a recreated screen keeps the shared player's speed (and shows its badge)
        local.playbackParameters.speed.takeIf { it != 1f }?.let(::setSpeed)
    }

    // ---- panels ----

    fun openMore() {
        if (host.inPip()) return
        Players.still.noteInteraction()
        val casting = host.casting()
        val state = MoreState(
            speed = speed,
            showSpeed = !casting,
            qualities = if (host.offline() || casting) null else host.qualities(),
            quality = host.quality(),
            sleepMinutes = sleepMinutes,
            sleepAfterEpisode = sleep.afterEpisode,
            sleepLeftMs = sleep.remainingMs(),
            canLock = !casting,
            canPip = !casting && host.pipSupported(),
            cast = if (cast.show) cast.casting else null,
        )
        panel.show(activity.getString(R.string.player_more), MorePanel.build(activity, state, moreActions))
    }

    fun openTracks() {
        if (host.inPip() || host.casting()) return
        val state = host.tracks() ?: return
        Players.still.noteInteraction()
        val a = host.tracksActions
        val actions = object : TracksActions {
            override fun audio(t: AudioTrack) { panel.close(); a.audio(t) }
            override fun subtitle(index: Int?) { panel.close(); a.subtitle(index) }
            override fun search() { panel.close(); a.search() }
            override fun fx(mode: String) { a.fx(mode) }
        }
        panel.show(activity.getString(R.string.player_tracks), TracksPanel.build(activity, state, actions))
    }

    /** the bar's Episodes button (an episode of a series, streamed: [EpisodesPanel.offered]) */
    fun showEpisodesButton(show: Boolean) {
        episodesButton.visibility = if (show) View.VISIBLE else View.GONE
    }

    /** *Episodes*: a tap on another episode plays it through [Host.playItem] (on the TV while casting); the playing one only closes. */
    fun openEpisodes() {
        if (host.inPip()) return
        val src = host.episodes() ?: return
        Players.still.noteInteraction()
        val content = EpisodesPanel.build(
            activity, activity.lifecycleScope, src.api, src.images, src.seriesId, src.season, src.currentId, episodesCache,
        ) { id ->
            panel.close()
            if (id != src.currentId) host.playItem(id)
        }
        panel.show(activity.getString(R.string.player_episodes), content)
    }

    private val moreActions = object : MoreActions {
        override fun speed(rate: Float) {
            panel.close()
            setSpeed(rate)
            host.flash(if (rate == 1f) activity.getString(R.string.player_speed_normal_toast) else MorePanel.rate(activity, rate), FLASH_MS)
        }

        override fun quality(bps: Long) {
            panel.close()
            host.changeQuality(bps)
        }

        override fun sleep(minutes: Int) {
            panel.close()
            if (minutes <= 0) { sleep.off(); sleepMinutes = 0 } else { sleep.set(minutes); sleepMinutes = minutes }
            showSleep()
            host.flash(
                if (minutes <= 0) activity.getString(R.string.player_sleep_off)
                else activity.getString(R.string.player_sleep_set, activity.getString(R.string.player_minutes, minutes)),
                FLASH_MS,
            )
        }

        override fun sleepAfterEpisode() {
            panel.close()
            sleep.setAfterEpisode()
            sleepMinutes = 0
            showSleep()
            host.flash(activity.getString(R.string.player_sleep_after_episode), FLASH_MS)
        }

        override fun lock() {
            panel.close()
            this@PlayerControls.lock()
        }

        override fun pip() {
            panel.close()
            host.enterPip()
        }

        override fun cast() {
            panel.close()
            // the Cast framework's own device chooser (or, while casting, its stop / volume dialog)
            castButton.performClick()
        }
    }

    // ---- speed ----

    /** the local player's speed (not saved; every title starts at 1, as in the web) */
    fun setSpeed(rate: Float) {
        speed = rate
        local.setPlaybackSpeed(rate)
        moreBadge.text = MorePanel.rate(activity, rate)
        moreBadge.visibility = if (rate != 1f) View.VISIBLE else View.GONE
    }

    /** a new title plays: speed back to 1; a sleep timer "after this episode" was meant for the previous one */
    fun newTitle() {
        if (speed != 1f) setSpeed(1f)
        if (sleep.afterEpisode) { sleep.off(); showSleep() }
    }

    // ---- sleep timer ----

    /** The activity's tick: the sleep timer fires (pauses the local player or the TV), the time left is refreshed. */
    fun tick() {
        if (sleep.due()) {
            sleepMinutes = 0
            host.pauseActive()
            host.flash(activity.getString(R.string.player_sleep_paused), SLEEP_FLASH_MS)
        }
        showSleep()
    }

    /** The title ended: with the sleep timer "after this episode" playback pauses there (no next episode starts). */
    fun titleEnded() {
        if (!sleep.afterEpisode) return
        host.pauseActive()
        host.flash(activity.getString(R.string.player_sleep_paused), SLEEP_FLASH_MS)
    }

    private fun showSleep() {
        val left = sleep.remainingMs()
        sleepDot.visibility = if (left != null) View.VISIBLE else View.GONE
        panel.content?.findViewById<TextView>(R.id.more_sleep_left)?.text = MorePanel.sleepLeft(activity, left)
    }

    // ---- lock ----

    fun lock() {
        if (locked || host.inPip()) return
        locked = true
        lockedBack.isEnabled = true
        panel.close()
        view.useController = false
        lockOverlay.visibility = View.VISIBLE
        host.flash(activity.getString(R.string.player_lock_locked), FLASH_MS)
    }

    fun unlock(announce: Boolean = true) {
        if (!locked) return
        locked = false
        lockedBack.isEnabled = false
        handler.removeCallbacks(unlockHeld)
        lockOverlay.visibility = View.GONE
        view.useController = !host.inPip()
        if (announce) {
            view.showController()
            host.flash(activity.getString(R.string.player_lock_unlocked), FLASH_MS)
        }
    }

    private val unlockHeld = Runnable { held = true; unlock() }
    private var held = false

    @SuppressLint("ClickableViewAccessibility") // a short tap calls performClick (the hint); TalkBack's long press unlocks
    private fun setUpLock() {
        lockOverlay.isClickable = true // every touch outside the lock is swallowed
        lockIcon.setOnClickListener { host.flash(activity.getString(R.string.player_lock_hold), FLASH_MS) }
        lockIcon.setOnLongClickListener { unlock(); true }
        lockIcon.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    held = false
                    v.isPressed = true
                    handler.postDelayed(unlockHeld, HOLD_MS)
                }
                MotionEvent.ACTION_UP -> {
                    handler.removeCallbacks(unlockHeld)
                    v.isPressed = false
                    if (!held) v.performClick()
                }
                MotionEvent.ACTION_CANCEL -> {
                    handler.removeCallbacks(unlockHeld)
                    v.isPressed = false
                }
            }
            true
        }
    }

    // ---- picture-in-picture, casting ----

    /** picture-in-picture: no panel and no lock in the small window */
    fun onPip(inPip: Boolean) {
        if (!inPip) return
        panel.close()
        unlock(announce = false)
    }

    /**
     * A cast started: the screen becomes the TV's remote (no panel left open, no lock, the local speed back to 1, the controller
     * shown); the sleep timer goes on and acts on the TV.
     */
    fun onCasting() {
        panel.close()
        unlock(announce = false)
        if (speed != 1f) setSpeed(1f)
        view.showController()
    }

    // ---- Chromecast ----

    fun updateCast(ui: CastUi) {
        cast = ui
        castButton.visibility = if (ui.show) View.VISIBLE else View.GONE
    }

    fun release() {
        handler.removeCallbacksAndMessages(null)
        panel.close()
    }

    private companion object {
        const val FLASH_MS = 1_400L
        const val SLEEP_FLASH_MS = 4_000L
        const val REASON_MS = 4_000L
        /** hold the lock this long to unlock (web: 0.6 s) */
        const val HOLD_MS = 600L
    }
}
