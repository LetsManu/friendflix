// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.fragment.app.FragmentActivity
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.friendflix.android.R
import app.friendflix.android.player.panels.EpisodesSource
import app.friendflix.android.player.panels.TracksActions
import app.friendflix.android.player.panels.TracksPanel
import app.friendflix.android.player.panels.TracksState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.TimeUnit

/** The player screen's layout in a bare activity: the bar, panels, lock and cast wiring of [PlayerControls] without a server. */
class ControlsTestActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(R.style.Theme_FriendFlix_Player)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
    }
}

@RunWith(RobolectricTestRunner::class)
class PlayerControlsTest {
    private lateinit var ac: ActivityController<ControlsTestActivity>
    private lateinit var activity: ControlsTestActivity
    private lateinit var view: PlayerView
    private lateinit var player: ExoPlayer
    private lateinit var host: FakeHost
    private lateinit var controls: PlayerControls
    private var clock = 1_000_000L

    private class FakeHost(val local: Player) : PlayerControls.Host {
        var casting = false
        var offline = false
        var pip = false
        var pipSupported = true
        var pipEntered = 0
        var activePaused = 0
        val flashes = mutableListOf<String>()
        var quality = 0L
        val qualityChanges = mutableListOf<Long>()
        var tracksState: TracksState? = null
        /** the activity's facts for the bar; null = derived from the fake's other answers (the interface default) */
        var facts: BarFacts? = null
        override fun bar(): BarFacts = facts ?: super.bar()
        override fun active(): Player = local
        override fun casting() = casting
        override fun offline() = offline
        override fun inPip() = pip
        override fun flash(text: String, ms: Long) { flashes += text }
        override fun pipSupported() = pipSupported
        override fun enterPip() { pipEntered++ }
        override fun pauseActive() { activePaused++; local.pause() }
        override fun tracks() = tracksState
        override val tracksActions = object : TracksActions {
            override fun audio(t: AudioTrack) {}
            override fun subtitle(index: Int?) {}
            override fun search() {}
            override fun fx(mode: String) {}
        }
        override fun qualities(): List<Pair<String, Long>>? = if (offline || casting) null else QUALITIES
        override fun quality() = quality
        override fun changeQuality(bps: Long) { qualityChanges += bps; quality = bps }
        override fun episodes(): EpisodesSource? = null
        override fun playItem(id: String) {}
    }

    @Before fun setUp() {
        ac = Robolectric.buildActivity(ControlsTestActivity::class.java).setup()
        activity = ac.get()
        view = activity.findViewById(R.id.player_view)
        player = ExoPlayer.Builder(activity).build()
        view.player = player
        host = FakeHost(player)
        controls = PlayerControls(activity, view, player, host) { clock }
    }

    @After fun tearDown() {
        player.release()
    }

    // ---- panel host: back, PiP ----

    @Test fun backClosesPanelFirst() {
        controls.openMore()
        assertTrue(controls.panel.isOpen)
        activity.onBackPressedDispatcher.onBackPressed()
        assertFalse(controls.panel.isOpen)
        assertFalse(activity.isFinishing)
        activity.onBackPressedDispatcher.onBackPressed() // no panel: the player closes as before
        assertTrue(activity.isFinishing)
    }

    @Test fun tapOutsideClosesThePanelAndThePlayerKeepsItsState() {
        player.playWhenReady = true
        controls.openMore()
        activity.findViewById<View>(R.id.player_panel_scrim).performClick()
        assertFalse(controls.panel.isOpen)
        assertTrue(player.playWhenReady)
        assertFalse(controls.panel.close()) // nothing open
    }

    @Test fun pipHidesPanel() {
        host.tracksState = tracks(audio = 2)
        controls.openTracks()
        assertTrue(controls.panel.isOpen)
        host.pip = true
        controls.onPip(true)
        assertFalse(controls.panel.isOpen)
        controls.openMore() // no panel in picture-in-picture
        assertFalse(controls.panel.isOpen)
    }

    // ---- fullscreen: the system bars come back hidden ----

    @Test fun closingAPanelHidesTheSystemBarsAgain() {
        controls.openMore()
        activity.showSystemBars() // e.g. the keyboard of subtitle search brought the navigation bar
        assertTrue(activity.systemBarsRequested())
        controls.panel.close()
        assertFalse(activity.systemBarsRequested())
    }

    @Test fun hidingTheControllerHidesTheSystemBarsAgain() {
        view.showController()
        activity.showSystemBars()
        view.hideController()
        ShadowLooper.idleMainLooper(1, TimeUnit.SECONDS)
        assertFalse(activity.systemBarsRequested())
    }

    @Test fun castingStartClosesThePanel() {
        controls.openMore()
        controls.onCasting()
        assertFalse(controls.panel.isOpen)
    }

    @Test fun backInAMoreSubListReturnsToTheMainListFirst() {
        controls.openMore()
        click(panelView(R.id.more_sleep)!!)
        assertNotNull(panelView(R.id.more_back))
        activity.onBackPressedDispatcher.onBackPressed()
        assertTrue(controls.panel.isOpen)
        assertNull(panelView(R.id.more_back))
        assertNotNull(panelView(R.id.more_sleep))
        activity.onBackPressedDispatcher.onBackPressed()
        assertFalse(controls.panel.isOpen)
        assertFalse(activity.isFinishing)
    }

    @Test fun castingStartUnlocksAndShowsTheController() {
        controls.lock()
        view.hideController()
        controls.onCasting()
        ShadowLooper.idleMainLooper(1, TimeUnit.SECONDS)
        assertTrue(view.useController)
        assertTrue(view.isControllerFullyVisible)
        assertEquals(View.GONE, activity.findViewById<View>(R.id.player_lock).visibility)
    }

    // ---- Chromecast ----

    @Test fun moreShowsPlayOnTvWheneverCastingIsPossible() {
        controls.updateCast(CastUi(ready = true, enabled = false))
        controls.openMore()
        assertNull(panelView(R.id.more_cast)) // the server does not allow casting
        controls.panel.close()

        controls.updateCast(CastUi(ready = true, enabled = true))
        controls.openMore()
        val row = panelView<View>(R.id.more_cast)
        assertNotNull(row)
        assertTrue(texts(row!!).contains(activity.getString(R.string.player_cast)))
        controls.panel.close()

        host.casting = true
        controls.updateCast(CastUi(ready = true, enabled = false))
        controls.openMore()
        assertTrue(texts(panelView<View>(R.id.more_cast)!!).contains(activity.getString(R.string.player_cast_playing)))
    }

    /** casting is possible in principle (Cast context, server allows it): the button shows before any TV was discovered */
    @Test fun chromecastButtonShowsWithoutADiscoveredDevice() {
        val cast = view.findViewById<View>(R.id.player_cast)
        controls.updateCast(CastUi(ready = true, enabled = true))
        assertEquals(View.VISIBLE, cast.visibility)
        controls.openMore()
        assertTrue(texts(panelView<View>(R.id.more_cast)!!).contains(activity.getString(R.string.player_cast)))
    }

    @Test fun chromecastButtonHiddenWithoutCastContextOrServerOrOffline() {
        val cast = view.findViewById<View>(R.id.player_cast)
        controls.updateCast(CastUi(ready = false, enabled = true)) // no Google Play services (no Cast context)
        assertEquals(View.GONE, cast.visibility)
        controls.updateCast(CastUi(ready = true, enabled = false)) // the server does not allow casting
        assertEquals(View.GONE, cast.visibility)
        host.offline = true
        controls.updateCast(CastUi(ready = true, enabled = true)) // a download
        assertEquals(View.GONE, cast.visibility)
        controls.openMore()
        assertNull(panelView(R.id.more_cast))
    }

    @Test fun chromecastButtonStaysFirstOnTheRightOfTheTopBar() {
        val cast = view.findViewById<View>(R.id.player_cast)
        controls.updateCast(CastUi(ready = true, enabled = true))
        assertEquals(View.VISIBLE, cast.visibility)
        val bar = view.findViewById<ViewGroup>(R.id.player_top_bar)
        val order = (0 until bar.childCount).map { bar.getChildAt(it).id }
        assertEquals(
            listOf(R.id.player_quality_chip, R.id.player_cast, R.id.player_info, R.id.player_tracks, R.id.player_more_wrap),
            order.dropWhile { it != R.id.player_quality_chip },
        )
        controls.updateCast(CastUi(ready = true, enabled = false))
        assertEquals(View.GONE, cast.visibility)
        host.casting = true
        controls.updateCast(CastUi(ready = true, enabled = false))
        assertEquals(View.VISIBLE, cast.visibility) // always while a cast runs
        host.casting = false
        host.offline = true
        controls.updateCast(CastUi(ready = true, enabled = true))
        assertEquals(View.GONE, cast.visibility) // never for a download
    }

    @Test fun bottomBarOrderIsEpisodesScenesNext() {
        val bar = view.findViewById<ViewGroup>(R.id.player_bottom_bar)
        val order = (0 until bar.childCount).map { bar.getChildAt(it).id }
        assertEquals(listOf(R.id.player_episodes, R.id.player_scenes, R.id.player_next_episode), order.dropWhile { it != R.id.player_episodes })
        // quality and picture-in-picture moved from the top bar into More
        assertEquals(0, activity.resources.getIdentifier("player_quality", "id", activity.packageName))
        assertEquals(0, activity.resources.getIdentifier("player_pip", "id", activity.packageName))
    }

    // ---- speed ----

    @Test fun speedFromTheMorePanelAndResetOnNewTitle() {
        controls.openMore()
        click(panelView(R.id.more_speed)!!)
        clickText("1.5×")
        assertEquals(1.5f, player.playbackParameters.speed)
        assertFalse(controls.panel.isOpen)
        val badge = view.findViewById<TextView>(R.id.player_more_badge)
        assertEquals(View.VISIBLE, badge.visibility)
        assertEquals("1.5×", badge.text.toString())
        controls.newTitle()
        assertEquals(1f, player.playbackParameters.speed)
        assertEquals(View.GONE, badge.visibility)
    }

    @Test fun titlePanelClosesOnATitleSwitchAndInPip() {
        var closed = 0
        controls.showTitlePanel("What’s next?", TextView(activity)) { closed++ }
        assertTrue(controls.panel.isOpen)
        controls.newTitle() // the post-play screen belongs to the finished title
        assertFalse(controls.panel.isOpen)
        assertEquals(1, closed)
        controls.showTitlePanel("What’s next?", TextView(activity))
        controls.onCasting()
        assertFalse(controls.panel.isOpen)
        host.pip = true
        assertFalse(controls.showTitlePanel("What’s next?", TextView(activity))) // never in picture-in-picture
        assertFalse(controls.panel.isOpen)
    }

    /** every panel belongs to the title on show: Tracks (its audio indexes), More, Episodes, subtitle search (its item id) close */
    @Test fun everyPanelClosesOnATitleSwitch() {
        host.tracksState = tracks(audio = 2)
        controls.openTracks()
        assertTrue(controls.panel.isOpen)
        controls.newTitle()
        assertFalse(controls.panel.isOpen)
        controls.openMore()
        assertTrue(controls.panel.isOpen)
        controls.newTitle()
        assertFalse(controls.panel.isOpen)
        controls.panel.show("Find subtitles", TextView(activity)) // the activity's own panels (subtitle search) too
        controls.newTitle()
        assertFalse(controls.panel.isOpen)
    }

    @Test fun speedIsNotOfferedWhileCasting() {
        host.casting = true
        controls.openMore()
        assertNull(panelView(R.id.more_speed))
        assertNull(panelView(R.id.more_quality))
        assertNotNull(panelView(R.id.more_sleep))
    }

    // ---- quality ----

    @Test fun qualityListChangesTheQualityAndIsHiddenOffline() {
        controls.openMore()
        click(panelView(R.id.more_quality)!!)
        clickText("720p")
        assertEquals(listOf(4_000_000L), host.qualityChanges)
        host.offline = true
        controls.openMore()
        assertNull(panelView(R.id.more_quality))
    }

    @Test fun qualityChipShowsTheReason() {
        val chip = view.findViewById<TextView>(R.id.player_quality_chip)
        controls.chip.bind(direct = false, maxBitrate = 4_000_000L, reason = "videoCodec")
        assertEquals(activity.getString(R.string.player_chip_converted, "720p"), chip.text.toString())
        chip.performClick()
        assertEquals(activity.getString(R.string.player_quality_reason_video_codec), host.flashes.last())
        controls.chip.bind(direct = false, maxBitrate = 20_000_000L, reason = "unheard-of")
        assertEquals(activity.getString(R.string.player_chip_converted, "1080p"), chip.text.toString())
        chip.performClick()
        assertEquals(activity.getString(R.string.player_quality_reason_other), host.flashes.last())
        controls.chip.bind(direct = true, maxBitrate = 0, reason = null)
        assertEquals(activity.getString(R.string.player_quality_original), chip.text.toString())
        controls.chip.show(false)
        assertEquals(View.GONE, chip.visibility)
    }

    // ---- sleep timer ----

    @Test fun sleepTimerPausesWhenDueAndShowsTheTimeLeft() {
        player.playWhenReady = true
        controls.openMore()
        click(panelView(R.id.more_sleep)!!)
        clickText(activity.getString(R.string.player_minutes, 15))
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.player_more_dot).visibility)
        controls.openMore()
        assertEquals(activity.getString(R.string.player_sleep_left, "15:00"), panelView<TextView>(R.id.more_sleep_left)!!.text.toString())
        clock += 60_000
        controls.tick()
        assertEquals(activity.getString(R.string.player_sleep_left, "14:00"), panelView<TextView>(R.id.more_sleep_left)!!.text.toString())
        assertEquals(0, host.activePaused)
        clock += 14 * 60_000
        controls.tick()
        assertEquals(1, host.activePaused)
        assertFalse(player.playWhenReady)
        assertEquals(activity.getString(R.string.player_sleep_paused), host.flashes.last())
        assertEquals(View.GONE, view.findViewById<View>(R.id.player_more_dot).visibility)
        controls.tick()
        assertEquals(1, host.activePaused) // once
    }

    @Test fun sleepAfterThisEpisodeIsKeptInTheTimer() {
        controls.openMore()
        click(panelView(R.id.more_sleep)!!)
        clickText(activity.getString(R.string.player_sleep_after_episode_option))
        assertTrue(controls.sleep.afterEpisode)
        assertEquals(activity.getString(R.string.player_sleep_after_episode), host.flashes.last())
        controls.openMore()
        click(panelView(R.id.more_sleep)!!)
        clickText(activity.getString(R.string.player_off))
        assertFalse(controls.sleep.afterEpisode)
        assertNull(controls.sleep.remainingMs())
    }

    @Test fun sleepAfterEpisodePausesAtTheEndAndANewTitleConsumesIt() {
        controls.openMore()
        click(panelView(R.id.more_sleep)!!)
        clickText(activity.getString(R.string.player_sleep_after_episode_option))
        controls.onCasting() // the TV plays on: the choice goes with it
        assertTrue(controls.sleep.afterEpisode)
        controls.titleEnded()
        assertEquals(1, host.activePaused)
        assertEquals(activity.getString(R.string.player_sleep_paused), host.flashes.last())
        controls.newTitle()
        assertFalse(controls.sleep.afterEpisode)
        controls.titleEnded() // nothing chosen any more: the end is left alone
        assertEquals(1, host.activePaused)
    }

    @Test fun aMinuteTimerOutlivesANewTitle() {
        controls.openMore()
        click(panelView(R.id.more_sleep)!!)
        clickText(activity.getString(R.string.player_minutes, 30))
        controls.newTitle()
        assertEquals(30 * 60_000L, controls.sleep.remainingMs())
        controls.titleEnded()
        assertEquals(0, host.activePaused)
    }

    // ---- lock ----

    @Test fun lockHidesTheControllerAndALongPressRestoresIt() {
        controls.openMore()
        click(panelView(R.id.more_lock)!!)
        assertFalse(view.useController)
        val overlay = activity.findViewById<View>(R.id.player_lock)
        assertEquals(View.VISIBLE, overlay.visibility)
        val icon = activity.findViewById<View>(R.id.player_lock_icon)
        // a short tap only says how to unlock
        touch(icon, MotionEvent.ACTION_DOWN)
        ShadowLooper.idleMainLooper(200, TimeUnit.MILLISECONDS)
        touch(icon, MotionEvent.ACTION_UP)
        assertFalse(view.useController)
        assertEquals(activity.getString(R.string.player_lock_hold), host.flashes.last())
        // held 0.6 s: unlocked
        touch(icon, MotionEvent.ACTION_DOWN)
        ShadowLooper.idleMainLooper(599, TimeUnit.MILLISECONDS)
        assertFalse(view.useController)
        ShadowLooper.idleMainLooper(1, TimeUnit.MILLISECONDS)
        assertTrue(view.useController)
        assertEquals(View.GONE, overlay.visibility)
        touch(icon, MotionEvent.ACTION_UP)
    }

    @Test fun backWhileLockedShowsTheHintAndKeepsThePlayer() {
        controls.lock()
        activity.onBackPressedDispatcher.onBackPressed()
        assertFalse(activity.isFinishing)
        assertTrue(controls.locked)
        assertEquals(activity.getString(R.string.player_lock_hold), host.flashes.last())
        controls.unlock()
        activity.onBackPressedDispatcher.onBackPressed()
        assertTrue(activity.isFinishing)
    }

    @Test fun lockIsLiftedForPictureInPicture() {
        controls.lock()
        host.pip = true
        controls.onPip(true)
        assertEquals(View.GONE, activity.findViewById<View>(R.id.player_lock).visibility)
        assertFalse(controls.locked)
    }

    @Test fun moreOffersPipOnlyWhenSupported() {
        controls.openMore()
        click(panelView(R.id.more_pip)!!)
        assertEquals(1, host.pipEntered)
        host.pipSupported = false
        controls.openMore()
        assertNull(panelView(R.id.more_pip))
    }

    // ---- tracks ----

    @Test fun tracksListsAudioOnlyWithMoreThanOneTrack() {
        val one = TracksPanel.build(activity, tracks(audio = 1), NoTracks)
        assertNull(one.findViewById(R.id.tracks_audio))
        val two = TracksPanel.build(activity, tracks(audio = 2), NoTracks)
        assertNotNull(two.findViewById(R.id.tracks_audio))
        assertTrue(texts(two).containsAll(listOf("English", "Japanese", "Deutsch", activity.getString(R.string.player_subtitles_off))))
    }

    @Test fun tracksPicksCloseThePanelAndCallTheActions() {
        val picked = mutableListOf<String>()
        host.tracksState = tracks(audio = 2)
        val h = host
        val c = PlayerControls(activity, view, player, object : PlayerControls.Host by h {
            override val tracksActions = object : TracksActions {
                override fun audio(t: AudioTrack) { picked += "audio:${t.index}" }
                override fun subtitle(index: Int?) { picked += "sub:$index" }
                override fun search() { picked += "search" }
                override fun fx(mode: String) { picked += "fx:$mode" }
            }
        }) { clock }
        c.openTracks()
        clickText("Japanese")
        assertFalse(c.panel.isOpen)
        c.openTracks()
        clickText("Deutsch")
        c.openTracks()
        clickText(activity.getString(R.string.player_subtitles_off))
        assertEquals(listOf("audio:2", "sub:7", "sub:null"), picked)
    }

    @Test fun tracksSoundSwitchesGiveTheMode() {
        val modes = mutableListOf<String>()
        val actions = object : TracksActions by NoTracks { override fun fx(mode: String) { modes += mode } }
        val v = TracksPanel.build(activity, tracks(audio = 1), actions)
        v.findViewById<SwitchCompat>(R.id.tracks_fx_voices).performClick()
        v.findViewById<SwitchCompat>(R.id.tracks_fx_night).performClick()
        v.findViewById<SwitchCompat>(R.id.tracks_fx_voices).performClick()
        v.findViewById<SwitchCompat>(R.id.tracks_fx_night).performClick()
        assertEquals(listOf("voices", "both", "night", "off"), modes)
        val on = TracksPanel.build(activity, tracks(audio = 1).copy(fxMode = "both"), actions)
        assertTrue(on.findViewById<SwitchCompat>(R.id.tracks_fx_voices).isChecked)
        assertTrue(on.findViewById<SwitchCompat>(R.id.tracks_fx_night).isChecked)
    }

    @Test fun tracksSoundDisabledWithANote() {
        val v = TracksPanel.build(activity, tracks(audio = 1).copy(fxDisabledReason = R.string.player_fx_unsupported), NoTracks)
        assertFalse(v.findViewById<SwitchCompat>(R.id.tracks_fx_voices).isEnabled)
        assertFalse(v.findViewById<SwitchCompat>(R.id.tracks_fx_night).isEnabled)
        assertTrue(texts(v).contains(activity.getString(R.string.player_fx_unsupported)))
    }

    @Test fun tracksSearchRowOnlyWhenAllowed() {
        assertNull(TracksPanel.build(activity, tracks(audio = 1), NoTracks).findViewById(R.id.tracks_search))
        assertNotNull(TracksPanel.build(activity, tracks(audio = 1).copy(canSearch = true), NoTracks).findViewById(R.id.tracks_search))
    }

    // ---- one rule for the bar: offline and casting (barState) ----

    /** everything the server and a stream could offer, on a phone with Google Play services */
    private val all = BarFacts(
        loaded = true, episode = true, hasNext = true, server = true, chip = true, qualities = true, subtitleSearch = true,
        fxSupported = true, pipSupported = true, cast = CastUi(ready = true, enabled = true), chapters = true, extras = true,
    )

    @Test fun barStateStreamingOffersEverything() {
        val s = barState(all)
        assertTrue(s.tracks && s.next && s.episodes && s.scenes && s.info && s.chip && s.castButton)
        assertTrue(s.speed && s.quality && s.bookmarks && s.lock && s.pip && s.subtitleSearch)
        assertEquals(false, s.castRow) // Play on TV
        assertFalse(s.castStatus)
        assertNull(s.fxDisabledReason)
    }

    @Test fun barStateOfflineHidesWhatNeedsTheServer() {
        val s = barState(all.copy(offline = true))
        assertFalse(s.episodes); assertFalse(s.scenes); assertFalse(s.info); assertFalse(s.bookmarks); assertFalse(s.subtitleSearch)
        assertFalse(s.quality); assertFalse(s.chip); assertFalse(s.next)
        assertFalse(s.castButton); assertNull(s.castRow) // never for a download
        // what works without the server stays
        assertTrue(s.tracks && s.speed && s.lock && s.pip)
        assertNull(s.fxDisabledReason) // the last known sound mode (R2)
    }

    @Test fun barStateCastingKeepsTheTvControlsAndDropsTheLocalOnes() {
        val s = barState(all.copy(casting = true))
        // not offered while casting (spec 4a)
        assertFalse(s.speed); assertFalse(s.quality); assertFalse(s.subtitleSearch); assertFalse(s.tracks); assertFalse(s.chip)
        assertFalse(s.lock); assertFalse(s.pip); assertFalse(s.next)
        assertEquals(R.string.player_fx_casting, s.fxDisabledReason)
        // they act on the TV
        assertTrue(s.episodes && s.scenes && s.info && s.bookmarks)
        // the Chromecast button, the Playing on TV row and the status line
        assertTrue(s.castButton)
        assertEquals(true, s.castRow)
        assertTrue(s.castStatus)
        assertTrue(barState(all.copy(casting = true, cast = CastUi(ready = true, enabled = false))).castButton)
    }

    /** Chromecast whenever casting is possible in principle (Task 12): online, a Cast context, the server allows it */
    @Test fun barStateCastButtonNeedsCastContextServerAndOnline() {
        assertTrue(barState(all.copy(cast = CastUi(ready = true, enabled = true))).castButton)
        assertEquals(false, barState(all.copy(cast = CastUi(ready = true, enabled = true))).castRow)
        val noContext = barState(all.copy(cast = CastUi(ready = false, enabled = true)))
        assertFalse(noContext.castButton); assertNull(noContext.castRow)
        val serverOff = barState(all.copy(cast = CastUi(ready = true, enabled = false)))
        assertFalse(serverOff.castButton); assertNull(serverOff.castRow)
        val offline = barState(all.copy(offline = true))
        assertFalse(offline.castButton); assertNull(offline.castRow)
    }

    @Test fun barStateFxOnOldAndroidHasTheUnsupportedNote() {
        assertEquals(R.string.player_fx_unsupported, barState(all.copy(fxSupported = false)).fxDisabledReason)
        assertNotNull(barState(all.copy(fxSupported = false, casting = true)).fxDisabledReason)
    }

    @Test fun offlinePlaybackHidesTheServerButtonsAndKeepsSpeedSleepLock() {
        host.offline = true
        host.facts = all.copy(offline = true)
        host.tracksState = tracks(audio = 1).copy(canSearch = true)
        controls.setChapters(listOf(Chapter(0.0, "A", null), Chapter(60.0, "B", null)))
        controls.showInfoButton(true)
        controls.updateCast(CastUi(ready = true, enabled = true))
        for (id in listOf(R.id.player_episodes, R.id.player_scenes, R.id.player_info, R.id.player_cast, R.id.player_quality_chip, R.id.player_next_episode)) {
            assertEquals(activity.resources.getResourceEntryName(id), View.GONE, view.findViewById<View>(id).visibility)
        }
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.player_tracks).visibility)
        controls.openMore()
        assertNull(panelView(R.id.more_bookmarks))
        assertNull(panelView(R.id.more_quality))
        assertNull(panelView(R.id.more_cast))
        assertNotNull(panelView(R.id.more_speed))
        assertNotNull(panelView(R.id.more_sleep))
        assertNotNull(panelView(R.id.more_lock))
        controls.openTracks()
        assertNull(panelView(R.id.tracks_search)) // no subtitle search for a download
        assertTrue(panelView<SwitchCompat>(R.id.tracks_fx_voices)!!.isEnabled)
    }

    @Test fun castingBarFollowsTheTvAndComesBackLocally() {
        host.tracksState = tracks(audio = 2)
        host.facts = all
        controls.chip.bind(direct = true, maxBitrate = 0, reason = null)
        controls.showInfoButton(true)
        controls.updateCast(CastUi(ready = true, enabled = true))
        val ids = listOf(R.id.player_tracks, R.id.player_next_episode, R.id.player_quality_chip, R.id.player_episodes, R.id.player_info, R.id.player_cast)
        assertEquals(ids.map { View.VISIBLE }, ids.map { view.findViewById<View>(it).visibility })
        assertEquals(View.GONE, activity.findViewById<View>(R.id.player_cast_status).visibility)

        host.casting = true
        host.facts = all.copy(casting = true)
        controls.onCasting()
        fun vis(id: Int) = view.findViewById<View>(id).visibility
        assertEquals(View.GONE, vis(R.id.player_tracks)) // audio, subtitles, search, sound: not while casting
        assertEquals(View.GONE, vis(R.id.player_next_episode)) // the TV's queue moves on by itself
        assertEquals(View.GONE, vis(R.id.player_quality_chip)) // no quality answer for the TV's stream
        assertEquals(View.VISIBLE, vis(R.id.player_episodes)) // a pick plays on the TV
        assertEquals(View.VISIBLE, vis(R.id.player_info)) // the TV's title
        assertEquals(View.VISIBLE, vis(R.id.player_cast)) // first on the right
        assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.player_cast_status).visibility)
        controls.openTracks()
        assertFalse(controls.panel.isOpen)
        controls.openMore()
        assertNull(panelView(R.id.more_speed))
        assertNull(panelView(R.id.more_quality))
        assertNull(panelView(R.id.more_lock))
        assertNull(panelView(R.id.more_pip))
        assertNotNull(panelView(R.id.more_sleep))
        assertTrue(texts(panelView<View>(R.id.more_cast)!!).contains(activity.getString(R.string.player_cast_playing)))
        controls.panel.close()

        host.casting = false
        host.facts = all
        controls.updateBar()
        assertEquals(ids.map { View.VISIBLE }, ids.map { view.findViewById<View>(it).visibility })
        assertEquals(View.GONE, activity.findViewById<View>(R.id.player_cast_status).visibility)
    }

    @Test fun chipShowsOnlyOnceTheStreamIsKnown() {
        host.facts = all.copy(chip = false)
        controls.updateBar()
        assertEquals(View.GONE, view.findViewById<View>(R.id.player_quality_chip).visibility)
        controls.chip.bind(direct = false, maxBitrate = 4_000_000L, reason = "network")
        host.facts = all
        controls.updateBar()
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.player_quality_chip).visibility)
    }

    // ---- helpers ----

    private object NoTracks : TracksActions {
        override fun audio(t: AudioTrack) {}
        override fun subtitle(index: Int?) {}
        override fun search() {}
        override fun fx(mode: String) {}
    }

    private fun tracks(audio: Int) = TracksState(
        audio = listOf(AudioTrack(1, "English", "eng", true), AudioTrack(2, "Japanese", "jpn", false)).take(audio),
        audioIndex = null,
        subs = listOf(7 to "Deutsch"),
        subIndex = null,
        canSearch = false,
        fxMode = "off",
        fxDisabledReason = null,
    )

    private fun <T : View> panelView(id: Int): T? = activity.findViewById<View>(R.id.player_panel_content)?.findViewById(id)

    private fun texts(v: View): List<String> = when (v) {
        is TextView -> listOf(v.text.toString())
        is ViewGroup -> (0 until v.childCount).flatMap { texts(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun find(v: View, text: String): TextView? = when {
        v is TextView && v.text.toString() == text -> v
        v is ViewGroup -> (0 until v.childCount).firstNotNullOfOrNull { find(v.getChildAt(it), text) }
        else -> null
    }

    private fun click(v: View) {
        var c: View? = v
        while (c != null && !c.isClickable) c = c.parent as? View
        assertNotNull(c)
        c!!.performClick()
        ShadowLooper.idleMainLooper()
    }

    private fun clickText(text: String) {
        val content = activity.findViewById<View>(R.id.player_panel_content)
        val tv = find(content, text)
        assertNotNull("no row \"$text\" in ${texts(content)}", tv)
        click(tv!!)
    }

    private fun touch(v: View, action: Int) {
        val t = SystemClock.uptimeMillis()
        val e = MotionEvent.obtain(t, t, action, 1f, 1f, 0)
        v.dispatchTouchEvent(e)
        e.recycle()
    }

}
