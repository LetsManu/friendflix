// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.annotation.OptIn
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.DefaultTimeBar
import androidx.media3.ui.PlayerView
import androidx.media3.ui.TimeBar
import app.friendflix.android.R
import app.friendflix.android.cast.CastController
import app.friendflix.android.player.panels.BookmarksPanel
import app.friendflix.android.player.panels.CastInfoPanel
import app.friendflix.android.player.panels.EpisodesPanel
import app.friendflix.android.player.panels.EpisodesSource
import app.friendflix.android.player.panels.MoreActions
import app.friendflix.android.player.panels.MorePanel
import app.friendflix.android.player.panels.MoreState
import app.friendflix.android.player.panels.PanelRows
import app.friendflix.android.player.panels.PlayerPanel
import app.friendflix.android.player.panels.ScenesPanel
import app.friendflix.android.player.panels.TracksActions
import app.friendflix.android.player.panels.TracksPanel
import app.friendflix.android.player.panels.TracksState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/** The Cast framework's side of the bar: attached ([ready]), the server offers casting ([enabled]), a device is on the network ([devices]). */
data class CastUi(val ready: Boolean, val enabled: Boolean, val devices: Boolean)

/**
 * What the bar is decided from ([barState]). The activity gives the playback side ([PlayerControls.Host.bar]); [PlayerControls]
 * adds its own: the Cast framework ([cast]), the title's chapters ([chapters]) and whether the title's extras are loaded ([extras]).
 */
data class BarFacts(
    /** a download plays (no server) */
    val offline: Boolean = false,
    /** a cast session plays on a TV; the screen is its remote */
    val casting: Boolean = false,
    /** a stream or a download is attached (Tracks has something to show) */
    val loaded: Boolean = false,
    /** the title on show is an episode of a series */
    val episode: Boolean = false,
    /** the title on show has a next episode */
    val hasNext: Boolean = false,
    /** the server answers for the title on show (Cast & info, bookmarks) */
    val server: Boolean = false,
    /** the local stream's quality is known (the chip has something to say) */
    val chip: Boolean = false,
    /** the local stream offers quality rungs */
    val qualities: Boolean = false,
    /** the server allows subtitle search (capability) */
    val subtitleSearch: Boolean = false,
    /** the device runs audio effects (Android 9+) */
    val fxSupported: Boolean = true,
    val pipSupported: Boolean = true,
    val cast: CastUi = CastUi(ready = false, enabled = false, devices = false),
    val chapters: Boolean = false,
    val extras: Boolean = false,
)

/** What the bar, More and Tracks offer: one rule for every button ([barState]). [castRow]: null = no row, true = *Playing on TV*. */
data class BarState(
    val tracks: Boolean,
    val next: Boolean,
    val episodes: Boolean,
    val scenes: Boolean,
    val info: Boolean,
    val chip: Boolean,
    val castButton: Boolean,
    val castStatus: Boolean,
    val speed: Boolean,
    val quality: Boolean,
    val bookmarks: Boolean,
    val lock: Boolean,
    val pip: Boolean,
    val castRow: Boolean?,
    val subtitleSearch: Boolean,
    /** a string resource saying why Clear voices / Night mode are off, or null */
    val fxDisabledReason: Int?,
)

/**
 * The bar's rule (spec §3 offline, §4a Chromecast). A download hides what needs the server: Episodes, Scenes, Cast & info,
 * bookmarks, subtitle search, quality, the chip and Chromecast; speed, audio effects, subtitles, sleep timer and lock stay.
 * While casting the screen is the TV's remote: Episodes, Scenes, Cast & info, bookmarks and the sleep timer act on the TV; audio,
 * subtitles, quality (and its chip: there is no quality answer for the TV's stream), speed, audio effects, subtitle search, lock,
 * picture-in-picture and the next-episode button (the TV's queue moves on by itself) are not offered.
 */
fun barState(f: BarFacts): BarState {
    val online = !f.offline
    val local = !f.casting
    val castButton = f.cast.ready && (f.casting || CastController.castable(f.offline, f.cast.enabled, f.cast.devices))
    return BarState(
        tracks = f.loaded && local,
        next = f.hasNext && online && local,
        episodes = f.episode && online,
        scenes = f.chapters && online,
        info = f.extras && f.server && online,
        chip = f.chip && online && local,
        castButton = castButton,
        castStatus = f.casting,
        speed = local,
        quality = f.qualities && online && local,
        bookmarks = f.server && online,
        lock = local,
        pip = local && f.pipSupported,
        castRow = if (castButton) f.casting else null,
        subtitleSearch = f.subtitleSearch && f.server && online && local,
        fxDisabledReason = fxDisabledReason(f.fxSupported, f.casting),
    )
}

/** What the Bookmarks panel needs: the API and the title on show (the TV's while casting). */
data class BookmarksSource(val api: PlayerApi, val itemId: String)

/** What the Cast & info panel needs: the API, the image loader and the title on show (the TV's while casting). */
data class InfoSource(val api: PlayerApi, val images: ImageLoader?, val itemId: String)

/**
 * The player bar's own controls (web Player.svelte bar), kept out of [PlayerActivity]: the panel host with the Tracks and More
 * panels, the speed (badge on More), the sleep timer (dot on More, checked by the activity's tick), lock controls, the quality
 * chip, the Chromecast button / *Play on TV* row, and the title's extras: Scenes (chapters), Bookmarks, their marks on the seek bar
 * and the trickplay preview while scrubbing. The activity supplies the playback side through [Host].
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
        /** the panels' image loader (chapter stills, trickplay sheets), or null without a server */
        fun images(): ImageLoader? = null
        /** what the Bookmarks panel needs, or null when bookmarks are not offered (a download, nothing loaded) */
        fun bookmarks(): BookmarksSource? = null
        /** what the Cast & info panel needs, or null when it is not offered (a download, nothing loaded) */
        fun info(): InfoSource? = null
        /** closes the player and opens the title's page (`/item/<id>`) in the app's web UI */
        fun openTitle(id: String) {}
        /** the playback side of the bar's rule ([barState]); the default reads it from the answers above */
        fun bar(): BarFacts = BarFacts(
            offline = offline(), casting = casting(), loaded = tracks() != null, episode = episodes() != null,
            server = info() != null || bookmarks() != null, qualities = qualities() != null, pipSupported = pipSupported(),
        )
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
    private var cast = CastUi(ready = false, enabled = false, devices = false)
    /** the title's extras (chapters, bookmarks) belong to the title on show: Cast & info follows it */
    private var extrasLoaded = false
    private val handler = Handler(Looper.getMainLooper())

    private val moreBadge: TextView = view.findViewById(R.id.player_more_badge)
    private val sleepDot: View = view.findViewById(R.id.player_more_dot)
    private val castButton: View = view.findViewById(R.id.player_cast)
    private val episodesButton: View = view.findViewById(R.id.player_episodes)
    private val scenesButton: View = view.findViewById(R.id.player_scenes)
    private val infoButton: View = view.findViewById(R.id.player_info)
    private val tracksButton: View = view.findViewById(R.id.player_tracks)
    private val nextButton: View = view.findViewById(R.id.player_next_episode)
    private val castStatus: View = activity.findViewById(R.id.player_cast_status)
    private val timeBar: DefaultTimeBar = view.findViewById(androidx.media3.ui.R.id.exo_progress)
    private val previewView: ImageView = view.findViewById(R.id.player_trickplay)
    /** the trickplay preview follows the scrub (declared before init, which registers it) */
    private val scrub = object : TimeBar.OnScrubListener {
        override fun onScrubStart(timeBar: TimeBar, position: Long) = scrubAt(position)
        override fun onScrubMove(timeBar: TimeBar, position: Long) = scrubAt(position)
        override fun onScrubStop(timeBar: TimeBar, position: Long, canceled: Boolean) { preview?.hide() }
    }
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
        scenesButton.setOnClickListener { openScenes() }
        infoButton.setOnClickListener { openInfo() }
        timeBar.addListener(scrub)
        setUpLock()
        // a recreated screen keeps the shared player's speed (and shows its badge)
        local.playbackParameters.speed.takeIf { it != 1f }?.let(::setSpeed)
    }

    // ---- panels ----

    fun openMore() {
        if (host.inPip()) return
        Players.still.noteInteraction()
        val bar = state()
        val state = MoreState(
            speed = speed,
            showSpeed = bar.speed,
            bookmarks = bar.bookmarks && host.bookmarks() != null,
            qualities = if (bar.quality) host.qualities() else null,
            quality = host.quality(),
            sleepMinutes = sleepMinutes,
            sleepAfterEpisode = sleep.afterEpisode,
            sleepLeftMs = sleep.remainingMs(),
            canLock = bar.lock,
            canPip = bar.pip,
            cast = bar.castRow,
        )
        panel.show(activity.getString(R.string.player_more), MorePanel.build(activity, state, moreActions))
    }

    fun openTracks() {
        val bar = state()
        if (host.inPip() || !bar.tracks) return
        val state = host.tracks()?.copy(canSearch = bar.subtitleSearch, fxDisabledReason = bar.fxDisabledReason) ?: return
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

    /** *Scenes*: a tap seeks the active player (the TV while casting) to the chapter's start and closes the panel */
    fun openScenes() {
        if (host.inPip() || host.offline() || chapters.isEmpty()) return
        Players.still.noteInteraction()
        val content = ScenesPanel.build(
            activity, activity.lifecycleScope, host.images(), chapters, host.active().currentPosition.coerceAtLeast(0) / 1000.0,
        ) { sec ->
            panel.close()
            host.active().seekTo((sec * 1000).toLong())
        }
        extrasPanel = content
        panel.show(activity.getString(R.string.player_scenes), content)
    }

    /** *Bookmarks* (More): positions and seeks are the active player's (a new bookmark takes the TV's position while casting) */
    fun openBookmarks() {
        if (host.inPip() || host.offline()) return
        val src = host.bookmarks() ?: return
        Players.still.noteInteraction()
        val content = BookmarksPanel.build(
            activity, activity.lifecycleScope, src.api, src.itemId,
            positionMs = { host.active().currentPosition.coerceAtLeast(0) },
            onSeek = { ms -> panel.close(); host.active().seekTo(ms) },
            onShare = ::share,
        ) { list ->
            // a list of the title left meanwhile never marks the new one
            if (host.bookmarks()?.itemId == src.itemId) setBookmarks(list)
        }
        extrasPanel = content
        panel.show(activity.getString(R.string.player_bookmarks), content)
    }

    /** the title on show's extras are known ([loadTitleExtras]): Cast & info shows for a streamed title (never a download) */
    fun showInfoButton(show: Boolean) {
        extrasLoaded = show
        updateBar()
    }

    /** *Cast & info*: the title on show (the TV's while casting); a title tapped in it is opened in the app's web UI */
    fun openInfo() {
        if (host.inPip() || host.offline()) return
        val src = host.info() ?: return
        Players.still.noteInteraction()
        val content = CastInfoPanel.build(activity, activity.lifecycleScope, src.api, src.images, src.itemId) { id -> host.openTitle(id) }
        extrasPanel = content
        panel.show(activity.getString(R.string.player_info), content)
    }

    /**
     * A panel of the title on show that the activity builds (the post-play screen, "More like this"): it closes with a title switch
     * ([clearTitleExtras]) like Scenes and Bookmarks; never in picture-in-picture (false then).
     */
    fun showTitlePanel(title: CharSequence, content: View, onClose: () -> Unit = {}): Boolean {
        if (host.inPip()) return false
        unlock(announce = false) // the title is over: the viewer needs the screen
        extrasPanel = content
        panel.show(title, content, onClose)
        return true
    }

    private fun share(url: String) {
        try { activity.startActivity(BookmarksPanel.shareIntent(url)) } catch (_: ActivityNotFoundException) { }
    }

    private val moreActions = object : MoreActions {
        override fun bookmarks() = openBookmarks()

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

    /**
     * a new title plays: speed back to 1; a sleep timer "after this episode" was meant for the previous one; its chapters, bookmarks,
     * marks and trickplay go (the new title's are loaded with it, [loadTitleExtras])
     */
    fun newTitle() {
        if (speed != 1f) setSpeed(1f)
        if (sleep.afterEpisode) { sleep.off(); showSleep() }
        clearTitleExtras()
    }

    // ---- scenes, bookmarks, marks, trickplay ----

    /** the title's chapters (normalised; empty = none or not loaded) */
    var chapters: List<Chapter> = emptyList()
        private set
    /** the title's bookmarks (the seek bar marks them) */
    var bookmarks: List<Bookmark> = emptyList()
        private set
    /** the seek bar's marks: chapter starts and bookmarks ([seekMarksMs]) */
    var marksMs = LongArray(0)
        private set
    private var trickplay: TrickplayInfo? = null
    private var preview: TrickplayPreview? = null
    private var extrasJob: Job? = null
    /** the open Scenes or Bookmarks panel: it belongs to the title on show */
    private var extrasPanel: View? = null

    /**
     * A title starts (where the activity loads the title): its chapters (when the server has them, [withChapters]) and bookmarks
     * are loaded on the IO dispatcher; a failure only leaves them out. Nothing for a download.
     */
    fun loadTitleExtras(api: PlayerApi, itemId: String, withChapters: Boolean) {
        clearTitleExtras()
        if (host.offline()) return
        showInfoButton(true)
        extrasJob = activity.lifecycleScope.launch {
            val ch = async(Dispatchers.IO) { if (withChapters) runCatching { api.chapters(itemId) }.getOrNull() else null }
            val bm = async(Dispatchers.IO) { runCatching { api.bookmarks(itemId) }.getOrNull() }
            setChapters(normaliseChapters(ch.await().orEmpty()))
            setBookmarks(bm.await().orEmpty())
        }
    }

    /** the Scenes button shows only with chapters (never for a download) */
    fun setChapters(list: List<Chapter>) {
        chapters = list
        updateBar()
        updateMarks()
    }

    fun setBookmarks(list: List<Bookmark>) {
        bookmarks = list
        updateMarks()
    }

    /** the stream's trickplay (null: none, or the server does not offer it) */
    fun setTrickplay(info: TrickplayInfo?) {
        trickplay = info?.takeIf(TrickplayPreview::usable)
        if (trickplay == null) preview?.hide()
    }

    /** the title's extras go; an open Scenes or Bookmarks panel (old chapter times, old item id) closes with them */
    fun clearTitleExtras() {
        if (extrasPanel != null && panel.content === extrasPanel) panel.close()
        extrasPanel = null
        extrasJob?.cancel()
        extrasJob = null
        extrasLoaded = false
        setTrickplay(null)
        bookmarks = emptyList()
        setChapters(emptyList())
    }

    private fun updateMarks() {
        marksMs = seekMarksMs(chapters, bookmarks)
        // PlayerView keeps these next to the media's own ad groups across its updates; played = unplayed colour (layout)
        view.setExtraAdGroupMarkers(marksMs, BooleanArray(marksMs.size))
    }

    private fun scrubAt(positionMs: Long) {
        val info = trickplay ?: return
        if (host.inPip()) return
        val p = preview ?: host.images()?.let { TrickplayPreview(previewView, it, activity.lifecycleScope) }?.also { preview = it } ?: return
        p.show(info, positionMs)
        placePreview(positionMs)
    }

    /** above the thumb, kept inside the time bar at both ends (web tipLeft) */
    private fun placePreview(positionMs: Long) {
        val duration = host.active().duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: return
        val barStart = (timeBar.parent as View).left + timeBar.left
        val w = previewView.width.takeIf { it > 0 } ?: PanelRows.dp(activity, TrickplayPreview.WIDTH_DP)
        val center = barStart + timeBar.width * (positionMs.coerceIn(0, duration).toFloat() / duration)
        val max = (barStart + timeBar.width - w).coerceAtLeast(barStart)
        previewView.translationX = (center - w / 2f).coerceIn(barStart.toFloat(), max.toFloat())
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
        preview?.hide()
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
        updateBar()
        view.showController()
    }

    // ---- the bar's rule ----

    /** the Cast framework's side (attached, casting offered, devices around); the bar follows */
    fun updateCast(ui: CastUi) {
        cast = ui
        updateBar()
    }

    /** what the bar offers now ([barState] of the activity's facts and the controls' own) */
    fun state(): BarState = barState(host.bar().copy(cast = cast, chapters = chapters.isNotEmpty(), extras = extrasLoaded))

    /**
     * The one place the bar's buttons are shown or hidden: the activity calls it whenever offline / casting / the title's data
     * change (start, a stream attached, a cast started or ended, a title switch); open panels read the same [state].
     */
    fun updateBar() {
        val s = state()
        show(tracksButton, s.tracks)
        show(nextButton, s.next)
        show(episodesButton, s.episodes)
        show(scenesButton, s.scenes)
        show(infoButton, s.info)
        show(castButton, s.castButton)
        show(castStatus, s.castStatus)
        chip.show(s.chip)
    }

    private fun show(v: View, on: Boolean) { v.visibility = if (on) View.VISIBLE else View.GONE }

    fun release() {
        handler.removeCallbacksAndMessages(null)
        extrasJob?.cancel()
        timeBar.removeListener(scrub)
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
