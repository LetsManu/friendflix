// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.FakeMediaSource
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.LooperMode

/** The reporter driven by a real ExoPlayer (fake clock and media) through [PlaybackEvents], as in the player screen. */
@RunWith(RobolectricTestRunner::class)
@LooperMode(LooperMode.Mode.PAUSED)
class PlaybackEventsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var player: ExoPlayer
    private val kinds = mutableListOf<PlaybackReporter.Kind>()
    private lateinit var reporter: PlaybackReporter
    private var clock = 0L

    @Before fun setUp() {
        player = TestExoPlayerBuilder(context).build()
        reporter = PlaybackReporter(
            send = { k, _ -> kinds += k },
            now = { clock },
            position = { Position(player.currentPosition, !player.playWhenReady) },
        )
        player.addListener(PlaybackEvents(reporter = { reporter }, offline = { null }))
        reporter.attach(ReportSession(ITEM, "ps-20261019-abcdef", ITEM, audioIndex = null, direct = true))
        player.setMediaSource(FakeMediaSource())
        player.prepare()
    }

    @After fun tearDown() { player.release() }

    @Test fun replayAfterTheEndStartsANewSessionAndIsStoppedOnRelease() {
        player.play()
        TestPlayerRunHelper.run(player).untilState(Player.STATE_ENDED)
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.STOP), kinds)
        assertTrue("ExoPlayer keeps playWhenReady at the end", player.playWhenReady)

        // PlayerView's play button at the end: seek to the start + play(); playWhenReady never changes
        player.seekTo(0)
        player.play()
        TestPlayerRunHelper.run(player).untilState(Player.STATE_READY)
        TestPlayerRunHelper.run(player).untilPendingCommandsAreFullyHandled()
        assertEquals("the replay is a new start (no progress for the ended session)", listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.STOP, PlaybackReporter.Kind.START), kinds)

        clock += PlaybackReporter.INTERVAL_MS
        reporter.tick()
        assertEquals(PlaybackReporter.Kind.PROGRESS, kinds.last())
        reporter.release()
        assertEquals(PlaybackReporter.Kind.STOP, kinds.last())
    }

    @Test fun pauseAndResumeThroughThePlayer() {
        player.play()
        TestPlayerRunHelper.run(player).untilState(Player.STATE_READY)
        player.pause()
        TestPlayerRunHelper.run(player).untilPendingCommandsAreFullyHandled()
        player.play()
        TestPlayerRunHelper.run(player).untilPendingCommandsAreFullyHandled()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.PROGRESS, PlaybackReporter.Kind.PROGRESS), kinds)
    }

    @Test fun pausedInTheBackgroundStopsTicking() {
        player.play()
        TestPlayerRunHelper.run(player).untilState(Player.STATE_READY)
        player.pause()
        TestPlayerRunHelper.run(player).untilPendingCommandsAreFullyHandled()
        val before = kinds.size
        repeat(30) { clock += 1_000; reporter.tick(background = true) }
        assertEquals("no reports while paused in the background", before, kinds.size)
        repeat(10) { clock += 1_000; reporter.tick(background = false) }
        assertEquals("on screen the paused title reports like the web", before + 1, kinds.size)
    }

    @Test fun gatedPlayerIgnoresPlayWhileNotAllowed() {
        var allowed = false
        val gated = GatedPlayer(player, mayPlay = { allowed })
        gated.play()
        assertFalse(player.playWhenReady)
        gated.setPlayWhenReady(true)
        assertFalse(player.playWhenReady)
        allowed = true
        gated.play()
        assertTrue(player.playWhenReady)
        allowed = false
        gated.pause()
        assertFalse("pausing is always allowed", player.playWhenReady)
    }

    companion object {
        const val ITEM = "5f1e2d3c4b5a69788796a5b4c3d2e1f0"
    }
}
