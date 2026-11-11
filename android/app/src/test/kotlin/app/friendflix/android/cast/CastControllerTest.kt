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
import com.google.android.gms.cast.CastMediaControlIntent
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.IOException
import java.util.concurrent.Executor

/**
 * The cast controller against the web's cast engine (web/src/lib/cast/engine.ts, lib/cast.ts, Player.svelte startCast). The request
 * bodies are fixtures copied from the web tests: `token-body*.json` = engine.test.ts "refresh" (`{itemId: 'film', startTicks:
 * secToTicks(60), audioIndex: 1, maxBitrate: 8_000_000}`) plus cast.test.ts `castBody` (`receiver: true` with the own receiver);
 * `queue-body*.json` = engine.test.ts prequeue (`{itemId: 'ep2', maxBitrate: 8_000_000, next: true, after: 'c1'}`, own receiver
 * with `receiver: true`).
 */
@RunWith(RobolectricTestRunner::class)
class CastControllerTest {
    private val direct = Executor { it.run() }
    private var clock = 1_000_000L
    /** every server call and local report, in the order they would leave the device */
    private val calls = mutableListOf<Pair<String, JSONObject?>>()
    private val answers = ArrayDeque<TokenAnswer>()
    private var tokens = 0
    /** what the token-free lookup answers (absent: not ours) and the ids it cannot reach */
    private val lookups = mutableMapOf<String, CastLookup>()
    private val lookupDown = mutableSetOf<String>()
    private var nextItem: ItemInfo? = ItemInfo("ep2", "Episode", "Second", "Bright Valley", "s1", 1, 2)

    private val server = object : CastServer {
        override fun session(body: JSONObject): TokenAnswer {
            calls += "POST /api/cast/session" to body
            return answers.removeFirstOrNull() ?: TokenAnswer.Ok(info(if (body.optBoolean("next")) "q${++tokens}" else "c${++tokens}"))
        }
        override fun revoke(castId: String) { calls += "DELETE /api/cast/session/$castId" to null }
        override fun lookup(castId: String): CastLookup? {
            calls += "GET /api/cast/session/$castId" to null
            if (castId in lookupDown) throw IOException("down")
            return lookups[castId]
        }
        override fun report(kind: PlaybackReporter.Kind, body: JSONObject) { calls += "POST /api/playback/${kind.path}" to body }
        override fun next(itemId: String): ItemInfo? { calls += "GET /api/items/$itemId/next" to null; return nextItem }
        override fun segments(itemId: String): List<Segment> { segmentCalls++; return emptyList() }
    }
    private var segmentCalls = 0

    private class FakeReceiver(override val custom: Boolean) : CastReceiver {
        val loads = mutableListOf<Triple<String, Int?, Boolean>>()
        val queued = mutableListOf<Pair<String, Boolean>>()
        val removed = mutableListOf<String>()
        val messages = mutableListOf<JSONObject>()
        var ended = 0
        override fun load(info: CastInfo, subIndex: Int?, autoplay: Boolean) { loads += Triple(info.castId, subIndex, autoplay) }
        override fun queue(info: CastInfo, autoplay: Boolean): Boolean { queued += info.castId to autoplay; return true }
        override fun dequeue(castId: String) { removed += castId }
        override fun send(msg: JSONObject) { messages += msg }
        override fun end() { ended++ }
        var playing: ReceiverMedia? = null
        var next: ReceiverMedia? = null
        override fun current() = playing
        override fun queuedNext() = next
    }

    private inner class Host(val onStop: () -> Unit) : CastHost {
        /** what had left the device when the hand-back happened */
        var callsAtReturn: List<String> = emptyList()
        var returned: Triple<String, Long?, Boolean>? = null
        var returnedEnded = false
        var failed: TokenAnswer? = null
        var failures = 0
        val titles = mutableListOf<String>()
        var casting = 0
        override fun stopLocal() = onStop()
        /** what the cast's snapshot showed at the moment the screen was told */
        var titleAtCasting: String? = null
        var probe: () -> String? = { null }
        override fun onCasting(itemId: String) { casting++; titleAtCasting = probe() }
        override fun onTitle(item: ItemInfo) { titles += item.id }
        override fun onFailed(answer: TokenAnswer?) { failures++; failed = answer }
        override fun onReturn(itemId: String, positionMs: Long?, play: Boolean, ended: Boolean) {
            returned = Triple(itemId, positionMs, play); returnedEnded = ended; callsAtReturn = calls.map { it.first }
        }
        override fun receiverStrings(): JSONObject = JSONObject().put("next", "Next episode")
    }

    /** the local player's reporter, as the player screen has it while it plays (its reports go into the same ordered log) */
    private var localPos = Position(60_000, paused = false)
    private val local = PlaybackReporter(send = { k, b -> calls += "POST /api/playback/${k.path}" to b }, now = { clock }, position = { localPos })
        .apply { attach(ReportSession("film", "ps-local", "ms-local", 1, direct = true)); onPlay() }

    private val host = Host { local.release() }

    /** a fake-clock scheduler: [advance] runs what is due */
    private val timers = mutableListOf<Triple<Long, () -> Unit, BooleanArray>>()
    private val schedule: (Long, () -> Unit) -> (() -> Unit) = { ms, block ->
        val cancelled = BooleanArray(1)
        timers += Triple(clock + ms, block, cancelled)
        ({ cancelled[0] = true })
    }
    private fun advance(ms: Long) {
        clock += ms
        val due = timers.filter { it.first <= clock }
        timers -= due.toSet()
        due.forEach { if (!it.third[0]) it.second() }
    }

    /** an io thread that runs only when told ([runIo]) */
    private val pendingIo = ArrayDeque<Runnable>()
    private val manualIo = Executor { pendingIo += it }
    private fun runIo() { while (pendingIo.isNotEmpty()) pendingIo.removeFirst().run() }
    private val still = StillWatching { clock }

    private fun controller(custom: Boolean = false) = FakeReceiver(custom).let { r ->
        r to CastController(server, r, host, still, io = direct, main = direct, now = { clock }, schedule = schedule)
    }

    private fun info(castId: String, runtimeMin: Long = 30) = CastInfo(
        castId = castId, expiresAt = clock + 60 * 60_000, playSessionId = "ps-$castId", mediaSourceId = "ms-$castId",
        runtimeTicks = runtimeMin * 60 * 10_000_000, startTime = 60, contentUrl = "https://ff.example/media/c/$castId/master.m3u8",
        contentType = "application/x-mpegURL", hlsSegmentFormat = "ts", title = "Film", seriesName = null, imageUrl = null,
        subtitles = emptyList(), report = if (castId.isNotEmpty()) "rt-$castId" else null,
    )

    private fun film(offline: Boolean = false) = CastStart(
        itemId = "film", positionMs = 60_000, audioIndex = 1, subIndex = null, maxBitrate = 8_000_000, prefsBitrate = 8_000_000,
        isEpisode = false, prefs = FlowPrefs(), offline = offline,
    )

    private fun episode() = film().copy(itemId = "ep1", isEpisode = true, audioIndex = null)

    private fun fixture(name: String) = javaClass.classLoader!!.getResource("cast/$name")!!.readText().trim()

    private fun playing(castId: String, positionMs: Long, durationMs: Long = 30 * 60_000, paused: Boolean = false) =
        ReceiverState(castId = castId, loaded = true, playing = !paused, paused = paused, positionMs = positionMs, durationMs = durationMs, idle = false)

    private fun paths() = calls.map { it.first }

    // ---- receiver app id ----

    @Test fun emptyAppIdUsesTheDefaultMediaReceiver() {
        assertEquals(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID, CastConfig.receiverAppId(""))
        assertEquals(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID, CastConfig.receiverAppId(null))
        // only the web's /^[0-9A-F]{8}$/ is taken (lib/cast.ts castConfigEnabled)
        assertEquals(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID, CastConfig.receiverAppId("abc"))
        assertEquals(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID, CastConfig.receiverAppId("0123abcd"))
        assertEquals("0123ABCD", CastConfig.receiverAppId("0123ABCD"))
    }

    @Test fun configAnswerIsReadLikeTheWeb() {
        assertEquals(CastConfig.Config(enabled = true, receiverAppId = ""), CastConfig.parse(JSONObject("""{"enabled":true}""")))
        assertEquals(CastConfig.Config(enabled = true, receiverAppId = "0123ABCD"), CastConfig.parse(JSONObject("""{"enabled":true,"receiverAppId":"0123ABCD"}""")))
        assertEquals(CastConfig.Config(enabled = false, receiverAppId = ""), CastConfig.parse(JSONObject("""{"enabled":false,"receiverAppId":"nope"}""")))
        assertNull(CastConfig.parse(null))
    }

    // ---- token requests ----

    @Test fun tokenRequestBodyEqualsTheWebEngines() {
        val (_, c) = controller()
        assertTrue(c.start(film()))
        assertEquals(fixture("token-body.json"), calls.first { it.first == "POST /api/cast/session" }.second.toString())
    }

    @Test fun tokenRequestToTheOwnReceiverAsksForItsReportToken() {
        val (r, c) = controller(custom = true)
        c.start(film())
        assertEquals(fixture("token-body-receiver.json"), calls.first { it.first == "POST /api/cast/session" }.second.toString())
        // the media goes to the receiver as the server answered it; its report token only on the private channel
        assertEquals(listOf(Triple("c1", null as Int?, true)), r.loads)
        val tok = r.messages.first { it.optString("t") == "tok" }
        assertEquals("c1", tok.getString("castId"))
        assertEquals("rt-c1", tok.getString("rt"))
    }

    @Test fun defaultReceiverGetsNoPrivateMessages() {
        val (r, c) = controller(custom = false)
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        assertTrue(r.messages.isEmpty())
    }

    @Test fun queueFromTheStart() {
        val (r, c) = controller()
        c.start(episode())
        val long = 90 * 60_000L
        assertTrue("not before the receiver plays it", r.queued.isEmpty())
        c.onReceiver(playing("c1", 61_000, durationMs = long)) // 89 minutes before the end: queued all the same
        val q = calls.filter { it.first == "POST /api/cast/session" && it.second!!.optBoolean("next") }
        assertEquals(1, q.size)
        assertEquals(fixture("queue-body.json"), q[0].second.toString())
        assertEquals(listOf("q2" to true), r.queued)
        c.onReceiver(playing("c1", long - 60_000, durationMs = long))
        assertEquals("asked once per title", 1, calls.count { it.second?.optBoolean("next") == true })
    }

    @Test fun queueNextToTheOwnReceiverAsksForItsReportToken() {
        val (r, c) = controller(custom = true)
        c.start(episode())
        c.onReceiver(playing("c1", 61_000))
        assertEquals(fixture("queue-body-receiver.json"), calls.first { it.second?.optBoolean("next") == true }.second.toString())
        assertTrue(r.messages.any { it.optString("t") == "tok" && it.optString("castId") == "q2" })
        val item = r.messages.last { it.optString("t") == "item" }
        assertEquals("q2", item.getJSONObject("next").getString("castId"))
    }

    @Test fun noQueueWithoutAutoplay() {
        val (r, c) = controller()
        c.start(episode().copy(prefs = FlowPrefs(autoplayNext = false)))
        c.onReceiver(playing("c1", 30 * 60_000 - 60_000))
        assertTrue(r.queued.isEmpty())
        assertFalse(calls.any { it.second?.optBoolean("next") == true })
    }

    @Test fun sleepAfterThisEpisodeQueuesNothingOnTheTv() {
        val (r, c) = controller()
        c.start(episode())
        c.sleepAfterEpisode = true
        c.onReceiver(playing("c1", 30 * 60_000 - 60_000))
        assertTrue(r.queued.isEmpty())
        assertFalse(calls.any { it.second?.optBoolean("next") == true })
    }

    @Test fun sleepAfterThisEpisodeTakesTheQueuedEpisodeOffAgain() {
        val (r, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 30 * 60_000 - 60_000))
        assertEquals(listOf("q2" to true), r.queued)
        c.sleepAfterEpisode = true
        assertEquals(listOf("q2"), r.removed)
        assertTrue(paths().contains("DELETE /api/cast/session/q2"))
        // switched off again: the next episode is queued once more
        c.sleepAfterEpisode = false
        c.onReceiver(playing("c1", 30 * 60_000 - 50_000))
        assertEquals(2, r.queued.size)
    }

    @Test fun theReceiverMovingOnStopsAndRevokesTheEndedToken() {
        val (_, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 30 * 60_000 - 60_000))
        calls.clear()
        c.onReceiver(playing("q2", 0))
        // (then the new title's own next episode is asked for: it ends within the queue window too)
        assertEquals(listOf("POST /api/playback/stop", "DELETE /api/cast/session/c1", "POST /api/playback/start"), paths().take(3))
        assertEquals("ps-c1", calls[0].second!!.getString("playSessionId"))
        assertEquals(30L * 60_000 * 10_000, calls[0].second!!.getLong("positionTicks"))
        assertEquals("ps-q2", calls[2].second!!.getString("playSessionId"))
        assertEquals("ep2", calls[2].second!!.getString("itemId"))
        assertEquals(listOf("ep2"), host.titles)
    }

    // ---- offline, hand-over ----

    @Test fun offlineMediaCannotBeCast() {
        assertFalse(CastController.castable(offline = true, enabled = true))
        assertFalse(CastController.castable(offline = false, enabled = false))
        assertTrue(CastController.castable(offline = false, enabled = true)) // with or without a discovered TV
        val (r, c) = controller()
        calls.clear()
        assertFalse(c.start(film(offline = true)))
        assertTrue("nothing asked, nothing stopped", calls.isEmpty())
        assertTrue(r.loads.isEmpty())
        assertFalse(c.casting)
    }

    @Test fun switchingToCastStopsLocalReportingFirst() {
        val (_, c) = controller()
        calls.clear()
        c.start(film())
        // like Player.svelte startCast: the local session's stop, then the token request
        assertEquals(listOf("POST /api/playback/stop", "POST /api/cast/session"), paths())
        assertEquals("ps-local", calls[0].second!!.getString("playSessionId"))
        // the local reporter is done: its ticks send nothing more
        clock += 60_000
        local.tick()
        local.onPause()
        assertEquals(2, calls.size)
        // the cast token is reported (the receiver plays): start once, progress on pause and every 10 s
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 62_000))
        c.onReceiver(playing("c1", 63_000, paused = true))
        clock += CastController.PROGRESS_MS
        c.tick()
        assertEquals(listOf("POST /api/playback/start", "POST /api/playback/progress", "POST /api/playback/progress"), paths().drop(2))
        val start = calls[2].second!!
        assertEquals("ps-c1", start.getString("playSessionId"))
        assertEquals("Transcode", start.getString("playMethod"))
        assertEquals(1, start.getInt("audioIndex"))
        assertEquals(1, host.casting)
    }

    @Test fun reportBodiesCarryVia() {
        val (_, c) = controller()
        calls.clear()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 62_000))
        clock += CastController.PROGRESS_MS
        c.tick()
        c.stop()
        val reports = calls.filter { it.first.startsWith("POST /api/playback/") }
        assertEquals(listOf("stop", "start", "progress", "stop"), reports.map { it.first.removePrefix("POST /api/playback/") })
        // the phone's own playback (the local reporter's stop before the cast) played on the device itself: no via
        assertFalse(reports[0].second!!.has("via"))
        for (r in reports.drop(1)) assertEquals(r.first, "chromecast", r.second!!.getString("via"))
    }

    @Test fun returningResumesAtTheReceiverPosition() {
        val (_, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 754_000))
        calls.clear()
        c.onSessionEnded()
        assertEquals(Triple("film", 754_000L, true), host.returned)
        assertFalse(host.returnedEnded)
        // the hand-back comes after the cast token's stop and revoke (the local info request must not meet a counted stream)
        assertEquals(listOf("POST /api/playback/stop", "DELETE /api/cast/session/c1"), host.callsAtReturn)
        assertEquals(listOf("POST /api/playback/stop", "DELETE /api/cast/session/c1"), paths())
        assertEquals(754_000L * 10_000, calls[0].second!!.getLong("positionTicks"))
        assertFalse(c.casting)
    }

    @Test fun returningWhilePausedStaysPaused() {
        val (_, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 300_000, paused = true))
        c.onSessionEnded()
        assertEquals(Triple("film", 300_000L, false), host.returned)
    }

    @Test fun anInterruptedMediaReturnsToTheDevice() {
        val (r, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 400_000))
        c.onMediaEnd(IdleReason.INTERRUPTED)
        assertEquals(Triple("film", 400_000L, true), host.returned)
        assertEquals(1, r.ended)
    }

    @Test fun theEndOnTheTvWithoutANextTitleEndsTheSession() {
        val (_, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 30 * 60_000 - 1_000))
        calls.clear()
        c.onMediaEnd(IdleReason.FINISHED)
        assertEquals(listOf("POST /api/playback/stop", "DELETE /api/cast/session/c1"), paths())
        assertTrue(host.returnedEnded)
    }

    @Test fun aRefusedTokenPlaysOnLocally() {
        answers += TokenAnswer.MaxStreams(2)
        val (r, c) = controller()
        assertTrue(c.start(film()))
        assertEquals(TokenAnswer.MaxStreams(2), host.failed)
        assertEquals(Triple("film", 60_000L, true), host.returned)
        assertTrue(r.loads.isEmpty())
        assertFalse(c.casting)
    }

    @Test fun aLoadTheReceiverRefusedIsRevoked() {
        val (_, c) = controller()
        c.start(film())
        calls.clear()
        c.onLoadFailed()
        assertEquals(listOf("DELETE /api/cast/session/c1"), paths())
        assertEquals(1, host.failures)
        assertEquals(Triple("film", 60_000L, true), host.returned)
    }

    @Test fun closingThePlayerStopsTheCast() {
        val (r, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 30 * 60_000 - 60_000))
        calls.clear()
        c.stop()
        assertEquals(listOf("DELETE /api/cast/session/q2", "POST /api/playback/stop", "DELETE /api/cast/session/c1"), paths())
        assertEquals(listOf("q2"), r.removed)
        assertEquals(1, r.ended)
        c.onSessionEnded()
        assertNull("the ended session is not handed back twice", host.returned)
    }

    @Test fun anExpiringTokenIsRenewedAtThePosition() {
        val (r, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 1_200_000))
        calls.clear()
        clock += 55 * 60_000 // expires within RENEW_BEFORE_MS
        c.tick()
        assertEquals(listOf("POST /api/playback/progress", "POST /api/playback/stop", "DELETE /api/cast/session/c1", "POST /api/cast/session"), paths())
        assertEquals(1_200_000L * 10_000, calls[3].second!!.getLong("startTicks"))
        assertEquals("c2", r.loads.last().first)
    }

    @Test fun anEpisodePickedWhileCastingPlaysOnTheTv() {
        val (r, c) = controller()
        assertFalse("nothing is cast yet", c.playOnTv(ItemInfo("ep5", "Episode", "Fifth", "Bright Valley", "s1", 1, 5)))
        c.start(episode())
        c.onReceiver(playing("c1", 61_000))
        calls.clear()
        assertTrue(c.playOnTv(ItemInfo("ep5", "Episode", "Fifth", "Bright Valley", "s1", 1, 5)))
        // the queued next episode goes first (a new load replaces the receiver's queue), then the playing token
        assertEquals(listOf("DELETE /api/cast/session/q2", "POST /api/playback/stop", "DELETE /api/cast/session/c1", "POST /api/cast/session"), paths())
        assertEquals(listOf("q2"), r.removed)
        val body = calls.last().second!!
        assertEquals("ep5", body.getString("itemId"))
        assertFalse("the server's resume point", body.has("startTicks"))
        assertFalse("default audio", body.has("audioIndex"))
        assertEquals(8_000_000L, body.getLong("maxBitrate"))
        assertEquals(Triple("c3", null as Int?, true), r.loads.last())
        assertEquals(listOf("ep5"), host.titles)
        assertEquals("ep5", c.itemId)
        assertTrue(c.casting)
        assertEquals(2, host.casting)
    }

    @Test fun aRefusedTokenForAPickedEpisodeReturnsWithoutAPosition() {
        val (_, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000))
        answers += TokenAnswer.Failed
        c.playOnTv(ItemInfo("ep5", "Episode", "Fifth", "Bright Valley", "s1", 1, 5))
        // the picked episode plays here from the server's resume point, not from 0
        assertEquals(Triple("ep5", null as Long?, true), host.returned)
        assertFalse(c.casting)
    }

    @Test fun aSessionEndBeforeThePickedEpisodeLoadedReturnsWithoutAPosition() {
        val c = CastController(server, FakeReceiver(false), host, still, io = manualIo, main = direct, now = { clock }, schedule = schedule)
        c.start(episode()); runIo()
        c.onReceiver(playing("c1", 61_000))
        c.playOnTv(ItemInfo("ep5", "Episode", "Fifth", "Bright Valley", "s1", 1, 5)) // its token request is still on its way
        c.onSessionEnded()
        assertEquals(Triple("ep5", null as Long?, true), host.returned)
    }

    // ---- fix round 1 ----

    @Test fun theTvSessionEndsAfterAFinishedTitle() {
        val (r, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 30 * 60_000 - 1_000))
        c.onMediaEnd(IdleReason.FINISHED, "c1")
        assertEquals("the bar stays a moment", 0, r.ended)
        advance(CastController.ENDED_HIDE_MS)
        assertEquals(1, r.ended)
    }

    @Test fun closingRightAfterTheEndEndsTheTvSessionAtOnce() {
        val (r, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 30 * 60_000 - 1_000))
        c.onMediaEnd(IdleReason.FINISHED, "c1")
        assertTrue(host.returnedEnded) // the player screen closes now: its stop() must still end the TV session
        c.stop()
        assertEquals(1, r.ended)
        advance(CastController.ENDED_HIDE_MS)
        assertEquals("ended once", 1, r.ended)
    }

    @Test fun theOwnReceiverGetsTheSubtitleStyle() {
        val (r, c) = controller(custom = true)
        c.start(film().copy(subtitleStyle = app.friendflix.android.player.SubtitleStyle(size = "l", color = "yellow").toJson()))
        val ui = r.messages.first { it.optString("t") == "ui" }
        assertEquals("""{"size":"l","color":"yellow","background":"semi","font":"sans"}""", ui.getJSONObject("sub").toString())
        assertEquals(CastController.COUNTDOWN_SECONDS, ui.getInt("countdown"))
        assertEquals("Next episode", ui.getJSONObject("strings").getString("next"))
        val (r2, c2) = controller(custom = true)
        c.stop()
        c2.start(film())
        assertEquals("""{"size":"m","color":"white","background":"semi","font":"sans"}""", r2.messages.first { it.optString("t") == "ui" }.getJSONObject("sub").toString())
    }

    @Test fun subtitleStyleMergesTheWebDefaults() {
        val st = app.friendflix.android.player.SubtitleStyle.parse(JSONObject("""{"size":"s","font":null}"""))
        assertEquals(app.friendflix.android.player.SubtitleStyle(size = "s"), st)
        assertEquals(app.friendflix.android.player.SubtitleStyle(), app.friendflix.android.player.SubtitleStyle.parse(null))
    }

    @Test fun aStaleQueueMintsNoToken() {
        val r = FakeReceiver(custom = false)
        val c = CastController(server, r, host, still, io = manualIo, main = direct, now = { clock }, schedule = schedule)
        c.start(episode())
        runIo()
        c.onReceiver(playing("c1", 61_000)) // within the queue window: the next episode is asked for
        c.stop() // ... and the cast ends before the answer is used
        runIo()
        assertTrue("next asked", calls.any { it.first == "GET /api/items/ep1/next" })
        assertFalse("no next token minted", calls.any { it.second?.optBoolean("next") == true })
        assertFalse(calls.any { it.first.startsWith("DELETE /api/cast/session/q") })
    }

    @Test fun aCancelledNextEpisodeMintsNoTokenAgain() {
        val (_, c) = controller(custom = true)
        c.start(episode())
        c.onReceiver(playing("c1", 61_000)) // within the queue window: ep2 is queued (q2)
        assertEquals(1, calls.count { it.second?.optBoolean("next") == true })
        c.onReceiverMessage(JSONObject().put("t", "cancel")) // cancelled on the TV: q2 leaves the queue, ep2 must not autoplay
        assertTrue(calls.any { it.first == "DELETE /api/cast/session/q2" })
        clock += 55 * 60_000
        c.tick() // renewal: the new token (c3) asks for its next episode again
        c.onReceiver(playing("c3", 62_000))
        assertTrue(calls.count { it.first == "GET /api/items/ep1/next" } >= 2)
        assertEquals("ep2 was cancelled: no token is minted for it", 1, calls.count { it.second?.optBoolean("next") == true })
    }

    @Test fun aFailedRenewalOfAPausedTvStaysPaused() {
        val (_, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 300_000, paused = true))
        answers += TokenAnswer.Failed
        clock += 55 * 60_000
        c.tick()
        assertEquals(Triple("film", 300_000L, false), host.returned)
        assertEquals(TokenAnswer.Failed, host.failed)
    }

    @Test fun aDevicePendingRefusalIsHandedToTheScreen() {
        answers += TokenAnswer.DevicePending
        val (_, c) = controller()
        c.start(film())
        assertEquals(TokenAnswer.DevicePending, host.failed)
    }

    // ---- Task 29: queue from the start, cast_unpinned, switchTo, resume ----

    @Test fun anUnpinnedPlayingTokenIsAskedAgainOnceAfterSixtySeconds() {
        answers += TokenAnswer.Ok(info("c1")) // the first token
        answers += TokenAnswer.Unpinned // the queue request: the TV has not fetched c1 yet
        val (r, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 1_000))
        assertEquals(1, calls.count { it.second?.optBoolean("next") == true })
        assertTrue(r.queued.isEmpty())
        advance(CastController.UNPINNED_RETRY_MS - 1)
        assertEquals("not before 60 s", 1, calls.count { it.second?.optBoolean("next") == true })
        advance(1)
        assertEquals(2, calls.count { it.second?.optBoolean("next") == true })
        assertEquals("the retry's token", listOf("q1" to true), r.queued)
    }

    @Test fun aSecondUnpinnedAnswerIsNotRetried() {
        answers += TokenAnswer.Ok(info("c1")); answers += TokenAnswer.Unpinned; answers += TokenAnswer.Unpinned
        val (r, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 1_000))
        advance(CastController.UNPINNED_RETRY_MS)
        advance(10 * CastController.UNPINNED_RETRY_MS)
        c.onReceiver(playing("c1", 2_000))
        assertEquals(2, calls.count { it.second?.optBoolean("next") == true })
        assertTrue(r.queued.isEmpty())
    }

    @Test fun otherQueueRefusalsAreNeverRetried() {
        answers += TokenAnswer.Ok(info("c1")); answers += TokenAnswer.Failed // 409 profile_changed / 400 bad_request
        val (_, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 1_000))
        advance(10 * CastController.UNPINNED_RETRY_MS)
        assertEquals(1, calls.count { it.second?.optBoolean("next") == true })
    }

    @Test fun theRetryDiesWithTheCast() {
        answers += TokenAnswer.Ok(info("c1")); answers += TokenAnswer.Unpinned
        val (_, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 1_000))
        c.stop()
        advance(CastController.UNPINNED_RETRY_MS)
        assertEquals(1, calls.count { it.second?.optBoolean("next") == true })
    }

    @Test fun aQueuedEpisodeTheReceiverDidNotStartGetsAFreshToken() {
        val (r, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000)) // q2 queued
        c.onReceiver(playing("c1", 30 * 60_000 - 1_000))
        calls.clear()
        c.onMediaEnd(IdleReason.FINISHED, "c1") // the receiver went idle but did not move on
        advance(CastController.ADVANCE_WAIT_MS)
        assertEquals(listOf("POST /api/playback/stop", "DELETE /api/cast/session/c1", "DELETE /api/cast/session/q2", "POST /api/cast/session"), paths())
        assertFalse("a plain token, not the queued one", calls.last().second!!.optBoolean("next"))
        assertEquals("ep2", calls.last().second!!.getString("itemId"))
        assertEquals("c3", r.loads.last().first)
    }

    @Test fun switchToReplacesTheToken() {
        val (r, c) = controller()
        assertFalse(c.switchTo("film2", null))
        c.start(episode())
        c.onReceiver(playing("c1", 61_000)) // q2 queued
        calls.clear()
        assertTrue(c.switchTo("film2", 90_000))
        assertEquals(listOf("DELETE /api/cast/session/q2", "POST /api/playback/stop", "DELETE /api/cast/session/c1", "POST /api/cast/session"), paths())
        val body = calls.last().second!!
        assertEquals("film2", body.getString("itemId"))
        assertEquals(90_000L * 10_000, body.getLong("startTicks"))
        assertEquals("c3", r.loads.last().first)
        assertEquals("film2", c.itemId)
        assertEquals("exactly one new token", 1, calls.count { it.first == "POST /api/cast/session" })
        // the kind comes from the token's answer: no episode here, so no next episode is asked for
        c.onReceiver(playing("c3", 91_000))
        assertFalse(calls.any { it.second?.optBoolean("next") == true })
    }

    private fun lookup(castId: String, itemId: String = "ep1", next: Boolean = false, reported: Boolean = true, series: String? = "Bright Valley") = CastLookup(
        castId = castId, itemId = itemId, mediaSourceId = "ms-$castId", playSessionId = "ps-$castId", expiresAt = clock + 60 * 60_000,
        runtimeTicks = 30L * 60 * 10_000_000, via = "chromecast", next = next, reported = reported, title = "First", seriesName = series,
        subtitles = emptyList(),
    )

    private val tokenUrl = "https://ff.example/media/c/" + "A".repeat(43) + "/master.m3u8"
    private val tokenId = CastIds.ofContentUrl(tokenUrl)!!

    @Test fun resumeAdoptsOurMedia() {
        lookups[tokenId] = lookup(tokenId)
        val (r, c) = controller(custom = true)
        calls.clear()
        c.resume(null, tokenUrl) // the castId is derived from the token in the URL
        assertTrue(c.casting)
        assertEquals("ep1", c.itemId)
        val snap = c.snapshot("Wohnzimmer-TV")!!
        assertEquals("Bright Valley", snap.title)
        assertEquals("First", snap.subtitle)
        assertTrue(snap.isEpisode)
        assertEquals(CastPhase.PLAYING, snap.state)
        assertEquals("Wohnzimmer-TV", snap.device)
        assertEquals(1, host.casting)
        // adopted as it plays: no second start report, the receiver is not loaded again, its texts are sent
        assertTrue(r.loads.isEmpty())
        assertFalse(paths().any { it == "POST /api/playback/start" })
        assertTrue(r.messages.any { it.optString("t") == "ui" })
        // the playing token is reported from now on
        c.onReceiver(playing(tokenId, 120_000))
        clock += CastController.PROGRESS_MS
        c.tick()
        assertEquals("ps-$tokenId", calls.last { it.first == "POST /api/playback/progress" }.second!!.getString("playSessionId"))
        // and it is stopped like any other
        c.stop()
        assertTrue(paths().contains("DELETE /api/cast/session/$tokenId"))
    }

    @Test fun resumeUsesTheOwnReceiversCastIdFirst() {
        val own = "b".repeat(32)
        lookups[own] = lookup(own)
        val (_, c) = controller(custom = true)
        c.resume(own, tokenUrl)
        assertEquals(listOf("GET /api/cast/session/$own"), paths().filter { it.startsWith("GET /api/cast") })
        assertTrue(c.casting)
    }

    @Test fun resumeIgnoresForeignMedia() {
        val (r, c) = controller()
        calls.clear()
        c.resume(null, tokenUrl) // lookup answers 404
        assertFalse(c.casting)
        assertNull(c.snapshot("TV"))
        assertEquals("only the lookup: no report, no revoke", listOf("GET /api/cast/session/$tokenId"), paths())
        assertTrue(r.ended == 0 && r.loads.isEmpty())
        // media without a token (the test clip) is not even looked up
        calls.clear()
        c.resume(null, "https://media.example/clip.m3u8")
        c.resume(null, null)
        assertTrue(calls.isEmpty())
    }

    @Test fun resumeKeepsEverythingWhenTheLookupFails() {
        lookupDown += tokenId
        val (_, c) = controller()
        c.resume(null, tokenUrl)
        assertFalse(c.casting)
        assertTrue(paths().none { it.startsWith("DELETE") })
        // asked again on the next trigger
        lookupDown.clear(); lookups[tokenId] = lookup(tokenId)
        c.resume(null, tokenUrl)
        assertTrue(c.casting)
    }

    @Test fun resumeTakesOverTheQueuedSuccessor() {
        val qUrl = "https://ff.example/media/c/" + "B".repeat(43) + "/master.m3u8"
        val qId = CastIds.ofContentUrl(qUrl)!!
        lookups[tokenId] = lookup(tokenId); lookups[qId] = lookup(qId, itemId = "ep2", next = true, reported = false)
        val (r, c) = controller()
        r.next = ReceiverMedia(null, qUrl)
        c.resume(null, tokenUrl)
        assertEquals("ep2", c.snapshot("TV")!!.next!!.itemId)
        c.onReceiver(playing(tokenId, 61_000))
        assertFalse("never a second queue token next to it", calls.any { it.second?.optBoolean("next") == true })
        // stopping revokes it as well
        c.stop()
        assertTrue(paths().containsAll(listOf("DELETE /api/cast/session/$tokenId", "DELETE /api/cast/session/$qId")))
    }

    @Test fun resumeQueuesItsOwnSuccessorWhenNoneIsThere() {
        lookups[tokenId] = lookup(tokenId)
        val (r, c) = controller()
        c.resume(null, tokenUrl)
        c.onReceiver(playing(tokenId, 61_000))
        assertEquals(1, calls.count { it.second?.optBoolean("next") == true })
        assertEquals(1, r.queued.size)
    }

    @Test fun resumeClosesTheEpisodeThatEndedMeanwhileOnce() {
        val oldId = "d".repeat(32)
        val hints = object : CastHints {
            var h: CastHints.Hint? = CastHints.Hint(oldId, tokenId)
            override fun read() = h
            override fun write(h: CastHints.Hint) { this.h = h }
            override fun clear() { h = null }
        }
        lookups[tokenId] = lookup(tokenId, itemId = "ep2", next = true); lookups[oldId] = lookup(oldId)
        val r = FakeReceiver(false)
        val c = CastController(server, r, host, still, io = direct, main = direct, now = { clock }, schedule = schedule, hints = hints)
        c.resume(null, tokenUrl)
        val stop = calls.single { it.first == "POST /api/playback/stop" }.second!!
        assertEquals("ps-$oldId", stop.getString("playSessionId"))
        assertEquals(30L * 60 * 10_000_000, stop.getLong("positionTicks"))
        assertEquals("a cast report (device hand-off)", "chromecast", stop.getString("via"))
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/$oldId" })
        // the hint now names the playing token
        assertEquals(tokenId, hints.h!!.castId)
        c.stop()
        hints.h = CastHints.Hint(oldId, tokenId)
        c.resume(null, tokenUrl)
        assertEquals("closed once", 1, calls.count { it.first == "DELETE /api/cast/session/$oldId" })
    }

    @Test fun resumeDoesNothingWhileACastRuns() {
        val (_, c) = controller()
        c.start(film())
        calls.clear()
        c.resume(null, tokenUrl)
        assertTrue(calls.isEmpty())
    }

    @Test fun theSnapshotShowsTheTitleAndTheEnd() {
        val (_, c) = controller()
        assertNull(c.snapshot("TV"))
        c.start(episode())
        assertEquals(CastPhase.CONNECTING, c.snapshot("TV")!!.state)
        c.onReceiver(playing("c1", 61_000))
        val s = c.snapshot("TV")!!
        assertEquals(CastPhase.PLAYING, s.state)
        assertEquals(61_000L, s.positionMs)
        assertEquals("the queued episode is the next line", "ep2", s.next!!.itemId)
        c.onReceiver(playing("c1", 30 * 60_000 - 1_000))
        c.onMediaEnd(IdleReason.FINISHED, "c1") // moves on to the queued one
        assertEquals("ep2", c.snapshot("TV")!!.itemId)
    }

    @Test fun theEndOnTheTvIsShownForAMoment() {
        val (_, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("c1", 30 * 60_000 - 1_000))
        c.onMediaEnd(IdleReason.FINISHED, "c1")
        assertEquals(CastPhase.ENDED, c.snapshot("TV")!!.state)
        advance(CastController.ENDED_HIDE_MS)
        assertNull(c.snapshot("TV"))
    }

    @Test fun lookupAnswersParseWithoutTokensOrUrls() {
        val l = CastLookup.parse(JSONObject("""{"castId":"${"a".repeat(32)}","itemId":"ep1","mediaSourceId":"ms","playSessionId":"ps","expiresAt":5,"runtimeTicks":10,"via":"chromecast","next":true,"reported":true,"title":"T","seriesName":"S","subtitles":[{"index":2,"language":"de","title":"Deutsch"}],"pins":1,"refused":{"count":0,"families":[]}}"""))!!
        assertEquals("ep1", l.itemId); assertTrue(l.next); assertTrue(l.reported)
        assertEquals("", l.subtitles.single().url)
        assertFalse(l.toCastInfo("https://x.example/media/c/t/master.m3u8").toString().contains("x.example"))
        assertNull(CastLookup.parse(JSONObject("""{"castId":"nope","itemId":"i","playSessionId":"p"}""")))
    }

    @Test fun castIdsMatchTheServersDerivation() {
        // sha256("A" * 43), first 32 hex characters (backend castIdOf(hashToken(token)))
        val expected = java.security.MessageDigest.getInstance("SHA-256").digest("A".repeat(43).toByteArray()).joinToString("") { "%02x".format(it) }.take(32)
        assertEquals(expected, CastIds.ofContentUrl("https://ff.example/media/c/${"A".repeat(43)}/master.m3u8"))
        assertNull(CastIds.ofContentUrl("https://ff.example/media/c/short/master.m3u8"))
        assertNull(CastIds.ofContentUrl("https://ff.example/media/c/${"A".repeat(44)}/master.m3u8"))
        assertNull(CastIds.ofContentUrl(null))
    }

    // ---- fix round 1 ----

    @Test fun stoppedOnTheTvRevokesTheQueuedToken() {
        val (_, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000)) // q2 queued
        calls.clear()
        c.onMediaEnd(IdleReason.CANCELLED, "c1")
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/q2" })
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/c1" })
        assertEquals(1, calls.count { it.first == "POST /api/playback/stop" })
    }

    @Test fun aLoadFailureRevokesTheQueuedToken() {
        val (_, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000))
        calls.clear()
        c.onLoadFailed()
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/q2" })
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/c1" })
        assertEquals(1, calls.count { it.first == "POST /api/playback/stop" })
    }

    @Test fun aSessionEndRevokesTheQueuedTokenOnce() {
        val (_, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000))
        calls.clear()
        c.onSessionEnded()
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/q2" })
    }

    @Test fun foreignMediaIsLetGoAfterTheAdvanceWait() {
        val (r, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000)) // q2 queued
        calls.clear()
        c.onReceiver(playing("other", 5_000)) // another sender took the TV
        clock += 10_000
        c.tick()
        assertTrue("no progress while foreign media plays", calls.isEmpty())
        clock += CastController.ADVANCE_WAIT_MS
        c.tick()
        assertEquals(1, calls.count { it.first == "POST /api/playback/stop" })
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/c1" })
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/q2" })
        assertFalse(calls.any { it.first == "POST /api/cast/session" })
        assertEquals("the TV is the other sender's now", 0, r.ended)
        assertTrue(r.removed.isEmpty())
        assertFalse(c.casting)
        assertNull(c.snapshot("TV"))
    }

    @Test fun foreignMediaNeverTriggersARenewal() {
        val (r, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("other", 1_000))
        calls.clear()
        clock += 55 * 60_000 // the token would be renewed now
        c.tick() // the first tick after the wait lets go; it never mints a token
        assertFalse(calls.any { it.first == "POST /api/cast/session" })
        assertEquals(listOf("c1"), r.loads.map { it.first })
    }

    @Test fun ourMediaAgainCancelsTheLetGo() {
        val (_, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("other", 1_000))
        c.onReceiver(playing("c1", 62_000)) // back
        clock += 2 * CastController.ADVANCE_WAIT_MS
        c.tick()
        assertTrue(c.casting)
    }

    @Test fun stopDuringAResumeLookupAdoptsNothing() {
        lookups[tokenId] = lookup(tokenId)
        val r = FakeReceiver(false)
        val c = CastController(server, r, host, still, io = manualIo, main = direct, now = { clock }, schedule = schedule)
        c.resume(null, tokenUrl) // the lookup is on its way
        c.stop() // sign-out, or the bar's Stop
        runIo()
        assertFalse(c.casting)
        assertNull(c.snapshot("TV"))
    }

    @Test fun anAdoptedCastLoadsItsSegmentsAndShowsItsTitleWhenTold() {
        lookups[tokenId] = lookup(tokenId)
        val (_, c) = controller(custom = true)
        host.probe = { c.snapshot("TV")?.title }
        c.resume(null, tokenUrl)
        assertEquals("Bright Valley", host.titleAtCasting)
        assertEquals(1, segmentCalls)
    }

    @Test fun theTitleIsInTheSnapshotWhenTheTokenLoads() {
        val (_, c) = controller()
        host.probe = { c.snapshot("TV")?.title }
        c.start(film())
        assertEquals("Film", host.titleAtCasting)
    }

    @Test fun noSecondQueuedItemBehindADeadOne() {
        val qUrl = "https://ff.example/media/c/" + "B".repeat(43) + "/master.m3u8"
        lookups[tokenId] = lookup(tokenId) // the queued item's lookup is a 404
        val (r, c) = controller()
        r.next = ReceiverMedia(null, qUrl)
        c.resume(null, tokenUrl)
        c.onReceiver(playing(tokenId, 61_000))
        assertTrue(r.queued.isEmpty())
        assertFalse(calls.any { it.second?.optBoolean("next") == true })
    }

    @Test fun aFailedLookupIsReportedToTheCaller() {
        lookupDown += tokenId
        val (_, c) = controller()
        var unknown = 0
        c.resume(null, tokenUrl) { unknown++ }
        assertEquals(1, unknown)
        lookupDown.clear()
        c.resume(null, tokenUrl) { unknown++ } // foreign (404): not "unknown"
        assertEquals(1, unknown)
    }

    // ---- fix round 2 ----

    /** media of another app (the Default Media Receiver plays it): loaded, and no FriendFlix token to name it */
    private fun tokenless(positionMs: Long) = ReceiverState(castId = null, loaded = true, playing = true, paused = false, positionMs = positionMs, durationMs = 600_000, idle = false)

    @Test fun foreignMediaWithoutATokenIsLetGoToo() {
        val (r, c) = controller()
        c.start(episode())
        c.onReceiver(playing("c1", 61_000)) // q2 queued
        calls.clear()
        c.onReceiver(tokenless(5_000))
        clock += 10_000
        c.tick()
        assertTrue("no progress while foreign media plays", calls.isEmpty())
        clock += 55 * 60_000 // the token would be renewed now
        c.tick()
        assertEquals(1, calls.count { it.first == "POST /api/playback/stop" })
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/c1" })
        assertEquals(1, calls.count { it.first == "DELETE /api/cast/session/q2" })
        assertFalse("never renewed over the other app's video", calls.any { it.first == "POST /api/cast/session" })
        assertEquals(0, r.ended)
        assertEquals(listOf("c1"), r.loads.map { it.first })
        assertFalse(c.casting)
    }

    @Test fun idleOrNoMediaIsNotForeign() {
        val (r, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        calls.clear()
        // nothing loaded (between media, the receiver idle): not another sender's media
        c.onReceiver(ReceiverState(castId = null, loaded = false, playing = false, paused = false, positionMs = 0, durationMs = 0, idle = true))
        c.onReceiver(ReceiverState(castId = null, loaded = false, playing = false, paused = false, positionMs = 0, durationMs = 0, idle = false))
        clock += 2 * CastController.ADVANCE_WAIT_MS
        c.tick()
        assertTrue(c.casting)
        assertFalse(calls.any { it.first == "POST /api/playback/stop" || it.first.startsWith("DELETE") })
        assertEquals(0, r.ended)
    }

    @Test fun aSwitchWhileForeignMediaPlaysKeepsTheNewToken() {
        val (_, c) = controller()
        c.start(film())
        c.onReceiver(playing("c1", 61_000))
        c.onReceiver(playing("other", 1_000)) // another sender took the TV
        clock += 15_000
        c.tick()
        assertTrue(c.switchTo("film2", null)) // the viewer picks a title: c2 is loaded
        calls.clear()
        c.onReceiver(playing("other", 2_000)) // the TV still shows the other media for a moment
        clock += 6_000 // 21 s after the first foreign status, 6 s after the switch
        c.tick()
        assertTrue(c.casting)
        assertFalse(calls.any { it.first == "DELETE /api/cast/session/c2" })
    }
}
