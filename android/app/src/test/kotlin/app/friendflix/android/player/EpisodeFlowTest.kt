// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Same markers and timings as the web player (web/src/lib/Player.svelte `skip`, lib/player/nextup.ts, routes/watch/[id] card logic,
 * lib/stillwatching.ts): skip button inside a segment except recaps and the last second, credits from an outro in the second half else
 * the last 25 s, a 10 s countdown that runs only while playing, and "still there?" after 3 autoplayed episodes or 90 min idle.
 */
class EpisodeFlowTest {
    private var clock = 1_000_000_000L
    private val still = StillWatching { clock }
    private val prefs = FlowPrefs()
    private val intro = Segment("intro", 60.0, 150.0)
    private val recap = Segment("recap", 0.0, 50.0)
    private val outro = Segment("outro", 1300.0, 1440.0)

    private fun flow(segments: List<Segment> = listOf(recap, intro, outro), kind: NextKind = NextKind.EPISODE, p: FlowPrefs = prefs) =
        EpisodeFlow(segments, kind, p, still).also { it.duration = 1440.0 }

    @Test fun introSkipShownOnlyInsideTheSegment() {
        val f = flow()
        assertNull(f.skip(59.9))
        assertEquals(intro, f.skip(60.0))
        assertEquals(intro, f.skip(148.9))
        assertNull("the last second of a segment shows no button", f.skip(149.0))
        assertNull(f.skip(150.0))
    }

    @Test fun recapHasNoSkipButtonLikeTheWebPlayer() {
        assertNull(flow().skip(10.0))
    }

    @Test fun introAutoSkipOncePerSegment() {
        val f = flow(p = prefs.copy(autoSkipIntro = true))
        assertEquals(150.0, f.autoSkip(61.0))
        assertNull("once", f.autoSkip(62.0))
        assertNull("off by default", flow().autoSkip(61.0))
    }

    @Test fun creditsStartAtTheOutroOrTheLast25Seconds() {
        assertEquals(1300.0, flow().creditsStart(), 0.0)
        assertEquals(1415.0, flow(listOf(intro)).creditsStart(), 0.0)
        // an "outro" in the first half is no end credits
        assertEquals(1415.0, flow(listOf(Segment("outro", 300.0, 400.0))).creditsStart(), 0.0)
        val unknown = EpisodeFlow(emptyList(), NextKind.EPISODE, prefs, still)
        assertTrue(unknown.creditsStart().isInfinite())
    }

    @Test fun creditsShowNextUpWithATenSecondCountdown() {
        val f = flow()
        assertEquals(FlowCard.Hidden, f.update(1299.0, playing = true, ended = false, dtMs = 100).card)
        var step = f.update(1300.0, playing = true, ended = false, dtMs = 0)
        assertEquals(FlowCard.NextUp(counting = true, secondsLeft = 10), step.card)
        var t = 0L
        while (!step.goNext && t < 20_000) { step = f.update(1300.0 + t / 1000.0, true, false, 100); t += 100 }
        assertTrue(step.goNext)
        assertEquals("the countdown lasts 10 s", 10_000L, t)
        assertTrue(step.autoplay)
    }

    @Test fun countdownWaitsWhilePaused() {
        val f = flow()
        f.update(1300.0, true, false, 0)
        f.update(1300.0, true, false, 4_000)
        repeat(100) { assertFalse(f.update(1304.0, playing = false, ended = false, dtMs = 1_000).goNext) }
        assertEquals(FlowCard.NextUp(counting = true, secondsLeft = 6), f.update(1304.0, false, false, 0).card)
    }

    @Test fun watchCreditsHidesTheCardUntilTheEnd() {
        val f = flow()
        f.update(1300.0, true, false, 0)
        f.watchCredits()
        assertEquals(FlowCard.Hidden, f.update(1350.0, true, false, 20_000).card)
        f.onEnded()
        assertEquals(FlowCard.NextUp(counting = true, secondsLeft = 10), f.update(1440.0, false, true, 0).card)
    }

    @Test fun seekingBackHidesTheCardAndStopsTheCountdown() {
        val f = flow()
        f.update(1300.0, true, false, 0)
        f.update(1305.0, true, false, 5_000)
        assertEquals(FlowCard.Hidden, f.update(600.0, true, false, 100).card)
        assertEquals(FlowCard.NextUp(counting = true, secondsLeft = 10), f.update(1300.0, true, false, 0).card)
    }

    @Test fun noAutoplayWhenSwitchedOff() {
        val f = flow(p = prefs.copy(autoplayNext = false))
        assertEquals(FlowCard.NextUp(counting = false, secondsLeft = 10), f.update(1300.0, true, false, 0).card)
        assertFalse(f.update(1400.0, true, false, 60_000).goNext)
    }

    @Test fun moviesAndLastEpisodesShowNoCard() {
        assertEquals(FlowCard.Hidden, flow(kind = NextKind.MOVIE).update(1430.0, true, false, 0).card)
        assertEquals(FlowCard.Hidden, flow(kind = NextKind.NONE).update(1430.0, true, false, 0).card)
    }

    /** One episode opened (by the viewer or by the countdown) and played into its credits until the countdown ends or the card asks. */
    private fun playEpisode(): EpisodeStep {
        still.opened()
        val f = flow()
        var step = f.update(1300.0, true, false, 0)
        var t = 0
        while (!step.goNext && step.card !is FlowCard.StillThere && t < 200) { step = f.update(1301.0, true, false, 100); t++ }
        return step
    }

    @Test fun threeAutoplayedEpisodesAskStillWatching() {
        repeat(3) { i -> assertTrue("episode ${i + 1} autoplays on", playEpisode().goNext) }
        val fourth = playEpisode()
        assertEquals(FlowCard.StillThere, fourth.card)
        assertFalse(fourth.goNext)
    }

    @Test fun anInteractionResetsTheChain() {
        repeat(2) { assertTrue(playEpisode().goNext) }
        still.noteInteraction()
        repeat(3) { assertTrue(playEpisode().goNext) }
        assertEquals(FlowCard.StillThere, playEpisode().card)
    }

    @Test fun keepWatchingCountsAsInteraction() {
        repeat(3) { playEpisode() }
        val f = flow()
        still.opened()
        assertEquals(FlowCard.StillThere, f.update(1300.0, true, false, 0).card)
        val step = f.keepWatching()
        assertTrue(step.goNext)
        assertFalse(step.autoplay)
        still.opened()
        assertEquals(FlowCard.NextUp(counting = true, secondsLeft = 10), flow().update(1300.0, true, false, 0).card)
    }

    @Test fun ninetyMinutesWithoutTouchAsks() {
        still.opened() // the viewer opened the first episode
        clock += 90 * 60_000L
        assertEquals(FlowCard.StillThere, flow().update(1300.0, true, false, 0).card)
    }

    @Test fun stillWatchingOffNeverAsks() {
        val p = prefs.copy(stillWatching = false)
        repeat(5) {
            still.opened()
            val f = flow(p = p)
            assertEquals(FlowCard.NextUp(counting = true, secondsLeft = 10), f.update(1300.0, true, false, 0).card)
            f.update(1310.0, true, false, 10_000).also { s -> assertTrue(s.goNext) }
        }
    }

    @Test fun previewAtTheEndGoesToTheNextEpisode() {
        val f = flow(listOf(Segment("preview", 1430.0, 1440.0)))
        assertTrue(f.skipGoesNext(f.skip(1431.0)!!, hasNext = true))
        assertFalse(f.skipGoesNext(f.skip(1431.0)!!, hasNext = false))
        assertFalse(flow().skipGoesNext(intro, hasNext = true))
    }
}
