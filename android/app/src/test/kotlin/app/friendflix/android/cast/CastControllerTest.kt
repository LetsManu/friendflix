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
    private var nextItem: ItemInfo? = ItemInfo("ep2", "Episode", "Second", "Bright Valley", "s1", 1, 2)

    private val server = object : CastServer {
        override fun session(body: JSONObject): TokenAnswer {
            calls += "POST /api/cast/session" to body
            return answers.removeFirstOrNull() ?: TokenAnswer.Ok(info(if (body.optBoolean("next")) "q${++tokens}" else "c${++tokens}"))
        }
        override fun revoke(castId: String) { calls += "DELETE /api/cast/session/$castId" to null }
        override fun report(kind: PlaybackReporter.Kind, body: JSONObject) { calls += "POST /api/playback/${kind.path}" to body }
        override fun next(itemId: String): ItemInfo? { calls += "GET /api/items/$itemId/next" to null; return nextItem }
        override fun segments(itemId: String): List<Segment> = emptyList()
    }

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
        override fun onCasting(itemId: String) { casting++ }
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

    @Test fun queueNextUsesNextTrueWithThePredecessor() {
        val (r, c) = controller()
        c.start(episode())
        val long = 90 * 60_000L
        c.onReceiver(playing("c1", 61_000, durationMs = long))
        assertTrue("not queued long before the end", r.queued.isEmpty())
        c.onReceiver(playing("c1", long - CastController.QUEUE_WITHIN_MS, durationMs = long))
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
        c.onReceiver(playing("c1", 30 * 60_000 - CastController.QUEUE_WITHIN_MS))
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
        assertFalse(CastController.castable(offline = true, enabled = true, devices = true))
        assertFalse(CastController.castable(offline = false, enabled = false, devices = true))
        assertFalse(CastController.castable(offline = false, enabled = true, devices = false))
        assertTrue(CastController.castable(offline = false, enabled = true, devices = true))
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
}
