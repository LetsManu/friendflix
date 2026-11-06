// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The reporter mirrors web/src/lib/Player.svelte: `send('start')` on the first play, `progress` every 10 s while started (interval +
 * timeupdate check), on pause and after a seek, `stop` at the end and when the player goes away (once). The bodies are compared with
 * fixtures copied from the web player's `body()` (test resources `player/report-*.json`).
 */
@RunWith(RobolectricTestRunner::class)
class PlaybackReporterTest {
    private var clock = 1_000_000L
    private var pos = Position(0, paused = false)
    private val sent = mutableListOf<Pair<PlaybackReporter.Kind, JSONObject>>()
    private val reporter = PlaybackReporter(send = { k, b -> sent += k to b }, now = { clock }, position = { pos })
    private val session = ReportSession(ITEM, PS, ITEM, audioIndex = null, direct = true)

    private fun kinds() = sent.map { it.first }
    private fun fixture(name: String) = javaClass.classLoader!!.getResource("player/$name")!!.readText().trim()

    @Test fun bodyEqualsTheWebPlayersDirectPlayBody() {
        val b = PlaybackReporter.body(session, Position(12_345, paused = false))
        assertEquals(fixture("report-direct.json"), b.toString())
    }

    @Test fun bodyEqualsTheWebPlayersTranscodeBody() {
        val b = PlaybackReporter.body(session.copy(audioIndex = 2, direct = false), Position(60_000, paused = true))
        assertEquals(fixture("report-transcode.json"), b.toString())
    }

    @Test fun startOnFirstPlayThenProgressEveryTenSeconds() {
        reporter.attach(session)
        reporter.tick()
        assertTrue("nothing before playback started", sent.isEmpty())
        reporter.onPlay()
        assertEquals(listOf(PlaybackReporter.Kind.START), kinds())
        for (s in 1..9) { clock += 1_000; reporter.tick() }
        assertEquals("not before 10 s", 1, sent.size)
        clock += 1_000; pos = Position(10_000, false); reporter.tick()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.PROGRESS), kinds())
        assertEquals(100_000_000L, sent.last().second.getLong("positionTicks"))
        for (s in 1..10) { clock += 1_000; reporter.tick() }
        assertEquals(3, sent.size)
        assertEquals(PlaybackReporter.Kind.PROGRESS, sent.last().first)
    }

    @Test fun pauseAndSeekReportProgress() {
        reporter.attach(session)
        reporter.onPlay()
        pos = Position(5_000, paused = true)
        reporter.onPause()
        reporter.onSeeked()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.PROGRESS, PlaybackReporter.Kind.PROGRESS), kinds())
        assertTrue(sent[1].second.getBoolean("isPaused"))
        reporter.onPlay() // resume: progress, not a second start
        assertEquals(PlaybackReporter.Kind.PROGRESS, sent.last().first)
    }

    @Test fun stopOnReleaseOnce() {
        reporter.attach(session)
        reporter.onPlay()
        reporter.release()
        reporter.release()
        reporter.tick()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.STOP), kinds())
    }

    @Test fun endedThenReleaseSendsOneStop() {
        reporter.attach(session)
        reporter.onPlay()
        reporter.onEnded()
        reporter.release()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.STOP), kinds())
    }

    @Test fun offlineProgressEveryTenSecondsAndPlayedFromNinetyPercent() {
        val saved = mutableListOf<Pair<Long, Boolean>>()
        val p = OfflineProgress({ ms, played -> saved += ms to played }, { clock }, { pos }, { 100_000 })
        pos = Position(0, false)
        p.flush()
        assertTrue("nothing at position 0", saved.isEmpty())
        pos = Position(5_000, false)
        p.tick()
        clock += 5_000; p.tick()
        clock += 5_000; pos = Position(15_000, false); p.tick()
        assertEquals(listOf(5_000L to false, 15_000L to false), saved)
        pos = Position(90_000, true)
        p.flush()
        assertEquals(90_000L to true, saved.last())
    }

    @Test fun releaseBeforePlaybackStartedSendsNothing() {
        reporter.attach(session)
        reporter.release()
        assertTrue(sent.isEmpty())
    }

    @Test fun endedStopsAndAPlayAfterTheEndStartsAgain() {
        reporter.attach(session)
        reporter.onPlay()
        reporter.onEnded()
        clock += 20_000; reporter.tick()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.STOP), kinds())
        reporter.onPlay() // replay from the end: a new start, like the web player
        reporter.release()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.STOP, PlaybackReporter.Kind.START, PlaybackReporter.Kind.STOP), kinds())
    }

    @Test fun switchingTheStreamStopsAndTheNewStreamStartsAgain() {
        reporter.attach(session)
        reporter.onPlay()
        reporter.switchStream()
        val other = session.copy(playSessionId = "ps-20261019-second", audioIndex = 1, direct = false)
        reporter.attach(other)
        reporter.onPlay()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.STOP, PlaybackReporter.Kind.START), kinds())
        assertEquals("ps-20261019-second", sent.last().second.getString("playSessionId"))
        assertEquals("Transcode", sent.last().second.getString("playMethod"))
    }

    @Test fun backgroundSendsProgressWithoutStopping() {
        reporter.attach(session)
        reporter.onPlay()
        reporter.onBackground()
        assertEquals(listOf(PlaybackReporter.Kind.START, PlaybackReporter.Kind.PROGRESS), kinds())
    }

    companion object {
        const val ITEM = "5f1e2d3c4b5a69788796a5b4c3d2e1f0"
        const val PS = "ps-20261019-abcdef"
    }
}
