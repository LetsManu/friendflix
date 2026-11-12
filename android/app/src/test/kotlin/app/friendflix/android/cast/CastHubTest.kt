// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import app.friendflix.android.player.FlowPrefs
import app.friendflix.android.player.ItemInfo
import app.friendflix.android.player.PlaybackReporter
import app.friendflix.android.player.Segment
import app.friendflix.android.player.StillWatching
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.Executor

/**
 * The app-scoped hub (Review Focus 7): closing the player no longer stops the cast, but sign-out and a profile switch do. The hub is
 * driven through its [CastHubCore] with a fake receiver link, like [CastControllerTest] drives the controller.
 */
@RunWith(RobolectricTestRunner::class)
class CastHubTest {
    private val direct = Executor { it.run() }
    private var clock = 1_000_000L
    private val calls = mutableListOf<String>()
    private val lookups = mutableMapOf<String, CastLookup>()
    private val down = mutableSetOf<String>()
    private var tokens = 0
    /** "<kind> <itemId> <positionMs>" of every report that left */
    private val reports = mutableListOf<String>()
    /** while non-null the report thread is stuck: its work is collected here */
    private var stuck: MutableList<Runnable>? = null
    private val still = StillWatching { clock }

    private val server = object : CastServer {
        override fun session(body: JSONObject): TokenAnswer {
            calls += "POST /api/cast/session"
            return TokenAnswer.Ok(info(if (body.optBoolean("next")) "q${++tokens}" else "c${++tokens}"))
        }
        override fun revoke(castId: String) { calls += "DELETE /api/cast/session/$castId" }
        override fun lookup(castId: String): CastLookup? {
            calls += "GET /api/cast/session/$castId"
            if (castId in down) throw java.io.IOException("down")
            return lookups[castId]
        }
        override fun report(kind: PlaybackReporter.Kind, body: JSONObject) {
            calls += "POST /api/playback/${kind.path}"
            reports += "${kind.path} ${body.optString("itemId")} ${body.optLong("positionTicks") / 10_000}"
        }
        override fun next(itemId: String): ItemInfo? = ItemInfo("ep2", "Episode", "Second", "Bright Valley", "s1", 1, 2)
        override fun segments(itemId: String): List<Segment> = emptyList()
        override fun watchLive(channelId: String): LiveCastInfo {
            calls += "POST /api/livetv/channels/$channelId/watch"
            val token = "T".repeat(43)
            return LiveCastInfo(channelId, token, "https://friend.example.com/media/l/$token/index.m3u8", clock + 60_000, "Nordlicht TV", 1, null, null)
        }
        override fun stopLive(token: String) { calls += "DELETE /api/livetv/watch" }
    }

    private class FakeLink(override val custom: Boolean) : CastLink {
        var ended = 0
        var published = 0
        var playing: ReceiverMedia? = null
        val messages = mutableListOf<JSONObject>()
        override var connected = true
        override var connecting = false
        val liveLoads = mutableListOf<String>()
        override fun loadLive(info: LiveCastInfo) { liveLoads += info.channelId }
        override val deviceName: String? = "Wohnzimmer-TV"
        override fun load(info: CastInfo, subIndex: Int?, autoplay: Boolean) {}
        override fun queue(info: CastInfo, autoplay: Boolean) = true
        override fun dequeue(castId: String) {}
        override fun send(msg: JSONObject) { messages += msg }
        override fun end() { ended++ }
        override fun current() = playing
        /** what the receiver reports when asked (the player's status, mirrored by publish) */
        var onPublish: () -> Unit = {}
        var toggled = 0
        override fun togglePause() { toggled++ }
        override fun publish() { published++; onPublish() }
        override fun release() {}
    }

    private class Host : CastHost {
        var returned: String? = null
        var picked = 0
        var casting = 0
        /** the screen plays on this device */
        var local = false
        val order = mutableListOf<String>()
        override fun playingLocally() = local
        override fun stopLocal() { order += "stopLocal"; local = false }
        override fun onCasting(itemId: String) { casting++; order += "onCasting" }
        override fun onTitle(item: ItemInfo) {}
        override fun onFailed(answer: TokenAnswer?) {}
        override fun onReturn(itemId: String, positionMs: Long?, play: Boolean, ended: Boolean) { returned = itemId }
        override fun receiverStrings() = JSONObject().put("next", "from the screen")
        override fun onDevicePicked() { picked++ }
    }

    private val timers = mutableListOf<Triple<Long, () -> Unit, BooleanArray>>()
    private fun advance(ms: Long) {
        clock += ms
        val due = timers.filter { it.first <= clock }
        timers -= due.toSet()
        due.forEach { if (!it.third[0]) it.second() }
    }

    private lateinit var events: MediaThreeReceiver.Events
    private lateinit var link: FakeLink

    private fun hub(custom: Boolean = false) = CastHubCore(
        server = server,
        linkFactory = { ev -> events = ev; FakeLink(custom).also { link = it } },
        still = still,
        io = Executor { r -> stuck?.add(r) ?: r.run() }, main = direct, now = { clock },
        schedule = { ms, block -> val c = BooleanArray(1); timers += Triple(clock + ms, block, c); ({ c[0] = true }) },
        strings = { JSONObject().put("next", "from the hub") },
    )

    private fun info(castId: String) = CastInfo(
        castId = castId, expiresAt = clock + 60 * 60_000, playSessionId = "ps-$castId", mediaSourceId = "ms-$castId",
        runtimeTicks = 30L * 60 * 10_000_000, startTime = 60, contentUrl = "https://ff.example/media/c/$castId/master.m3u8",
        contentType = "application/x-mpegURL", hlsSegmentFormat = "ts", title = "First", seriesName = "Bright Valley", imageUrl = null,
        subtitles = emptyList(), report = "rt-$castId",
    )

    private fun cast(h: CastHubCore, itemId: String = "ep1", prefs: FlowPrefs = FlowPrefs()) {
        val c = h.controller
        assertTrue(c.start(CastStart(itemId, 60_000, null, null, 8_000_000, 8_000_000, true, prefs, offline = false)))
        events.onState(playing("c1", 61_000))
    }

    private fun playing(castId: String, positionMs: Long) = ReceiverState(
        castId = castId, loaded = true, playing = true, paused = false, positionMs = positionMs, durationMs = 30 * 60_000, idle = false,
    )

    @Test fun nextSwitchesToTheQueuedEpisodeAtTheRealPosition() {
        val h = hub()
        h.attach(Host())
        cast(h)
        events.onState(playing("c1", 300_000)) // five minutes into episode 1
        assertEquals("ep2", h.state.value!!.next?.itemId)
        repeat(3) { still.noteAutoplay() }
        assertTrue(still.shouldAsk(FlowPrefs()))
        reports.clear()
        assertTrue(h.next())
        events.onState(playing("c3", 1_000)) // the TV plays the new token: its start is reported
        val stopStart = reports.filter { it.startsWith("stop") || it.startsWith("start") }
        assertEquals(2, stopStart.size)
        assertEquals("stop ep1 300000", stopStart[0])
        assertTrue(stopStart[1], stopStart[1].startsWith("start ep2"))
        assertTrue("the skip is no 'advanced' progress: " + reports, reports.none { it.startsWith("progress ep1") || it == "stop ep1 1800000" })
        assertFalse("the tap is an interaction: the autoplay chain starts over", still.shouldAsk(FlowPrefs()))
    }

    @Test fun castLiveWithoutATvOpensTheChooserAndPlaysOnThePickedOne() {
        val h = hub()
        val host = Host()
        h.attach(host)
        link.connected = false
        var picks = 0
        val answers = mutableListOf<Boolean>()
        // no chooser can be shown: false at once
        h.castLive("nordlicht-tv", { false }) { answers += it }
        assertEquals(listOf(false), answers)
        // the chooser opens; the channel waits for the TV the viewer picks, and goes there (not the player screen's title)
        h.castLive("nordlicht-tv", { picks++; true }) { answers += it }
        assertEquals(1, picks)
        assertEquals(1, answers.size)
        link.connected = true
        events.onSessionStarted()
        assertEquals(listOf(false, true), answers)
        assertEquals(0, host.picked)
        assertEquals(listOf("nordlicht-tv"), link.liveLoads)
        assertTrue(h.state.value!!.live)
        // the bar's play / pause drives the receiver; a profile switch ends the live cast
        h.playPause()
        assertEquals(1, link.toggled)
        h.useProfile("p1")
        h.noteProfile("p2")
        assertNull(h.state.value)
        assertEquals("DELETE /api/livetv/watch", calls.last())
        // nobody picks a TV in time: false, and a later session start is an ordinary one
        link.connected = false
        h.castLive("hafenkanal", { true }) { answers += it }
        advance(CastHubCore.PICK_WAIT_MS)
        assertEquals(listOf(false, true, false), answers)
        events.onSessionStarted()
        assertEquals(1, host.picked)
        assertEquals(listOf("nordlicht-tv"), link.liveLoads)
    }

    @Test fun aChooserClosedWithoutAPickAnswersFalseAtOnce() {
        val h = hub()
        h.attach(Host())
        link.connected = false
        val answers = mutableListOf<Boolean>()
        h.castLive("nordlicht-tv", { true }) { answers += it }
        h.chooserClosed()
        advance(CastHubCore.DISMISS_GRACE_MS)
        assertEquals("closed without a pick: no 40-s wait", listOf(false), answers)
        // closed because a TV was picked: it is connecting, the channel waits for it
        h.castLive("nordlicht-tv", { true }) { answers += it }
        link.connecting = true
        h.chooserClosed()
        advance(CastHubCore.DISMISS_GRACE_MS)
        assertEquals(listOf(false), answers)
        link.connecting = false
        link.connected = true
        events.onSessionStarted()
        assertEquals(listOf(false, true), answers)
        assertEquals(listOf("nordlicht-tv"), link.liveLoads)
    }

    @Test fun aTvStillConnectingAtTheTimeoutGetsOneBoundedExtension() {
        val h = hub()
        val host = Host()
        h.attach(host)
        link.connected = false
        val answers = mutableListOf<Boolean>()
        h.castLive("nordlicht-tv", { true }) { answers += it }
        link.connecting = true
        advance(CastHubCore.PICK_WAIT_MS)
        assertTrue("still connecting: it waits on", answers.isEmpty())
        advance(CastHubCore.CONNECT_WAIT_MS - 1)
        assertTrue(answers.isEmpty())
        advance(1)
        assertEquals("never longer than PICK_WAIT_MS + CONNECT_WAIT_MS", listOf(false), answers)
        // connected within the extension: the channel goes there
        link.connecting = true
        h.castLive("hafenkanal", { true }) { answers += it }
        advance(CastHubCore.PICK_WAIT_MS + 5_000)
        link.connecting = false
        link.connected = true
        events.onSessionStarted()
        assertEquals(listOf(false, true), answers)
        assertEquals(0, host.picked)
    }

    @Test fun nextWithoutAQueuedEpisodeIsRefused() {
        val h = hub()
        assertFalse("no cast", h.next())
        h.attach(Host())
        cast(h, prefs = FlowPrefs(autoplayNext = false))
        events.onState(playing("c1", 300_000))
        assertNull("autoplay off: nothing is queued", h.state.value!!.next)
        calls.clear()
        assertFalse(h.next())
        assertTrue("nothing was switched", calls.isEmpty())
        assertEquals("ep1", h.state.value!!.itemId)
    }

    @Test fun openIsOnlyForARunningCast() {
        val h = hub()
        assertNull("no cast", h.openTarget())
        h.attach(Host())
        cast(h, prefs = FlowPrefs(autoplayNext = false))
        assertEquals("ep1", h.openTarget())
        events.onMediaEnd(IdleReason.FINISHED, "c1")
        assertEquals(CastPhase.ENDED, h.state.value!!.state)
        assertNull("the bar still shows the ended title, but nothing runs to be the remote of", h.openTarget())
    }

    @Test fun theBarsPlayPauseAndStopAreInteractions() {
        val h = hub()
        h.attach(Host())
        cast(h)
        repeat(3) { still.noteAutoplay() }
        h.playPause()
        assertEquals(1, link.toggled)
        assertFalse(still.shouldAsk(FlowPrefs()))
        repeat(3) { still.noteAutoplay() }
        h.userStop()
        assertFalse(still.shouldAsk(FlowPrefs()))
        assertFalse(h.controller.casting)
    }

    @Test fun stopThenWaitsForTheReportsAndGivesUpAfterAWhile() {
        val h = hub()
        h.attach(Host())
        cast(h)
        val queued = mutableListOf<Runnable>()
        stuck = queued // the report thread is busy
        var done = 0
        h.stopThen { done++ }
        assertFalse(h.controller.casting)
        assertEquals("the stop report and the revoke are still queued", 0, done)
        stuck = null
        queued.forEach { it.run() }
        assertEquals("reports out: answer", 1, done)
        assertTrue(reports.any { it.startsWith("stop ep1") })
        // a stuck thread: the answer comes after the timeout, once
        val h2 = hub()
        h2.attach(Host())
        cast(h2)
        stuck = mutableListOf()
        var done2 = 0
        h2.stopThen { done2++ }
        advance(CastHubCore.REPORT_WAIT_MS - 1)
        assertEquals(0, done2)
        advance(1)
        assertEquals(1, done2)
        (stuck as MutableList<Runnable>).forEach { it.run() }
        advance(60_000)
        assertEquals("once", 1, done2)
    }

    @Test fun aProfileSwitchThatStopsTheCastWaitsForTheReportsToo() {
        val h = hub()
        h.attach(Host())
        h.useProfile("anna")
        cast(h)
        var same = 0
        h.noteProfileThen("anna") { same++ }
        assertEquals("the same profile: nothing owed, answer at once", 1, same)
        assertTrue(h.controller.casting)
        val queued = mutableListOf<Runnable>()
        stuck = queued
        var other = 0
        h.noteProfileThen("ben") { other++ }
        assertFalse(h.controller.casting)
        assertEquals(0, other)
        stuck = null
        queued.forEach { it.run() }
        assertEquals(1, other)
        var idle = 0
        h.noteProfileThen("ben") { idle++ } // no cast: nothing to wait for
        assertEquals(1, idle)
    }

    @Test fun closingThePlayerKeepsTheCast() {
        val h = hub()
        val host = Host()
        assertNotNull(h.attach(host))
        cast(h)
        calls.clear()
        h.detach(host)
        assertTrue("no revoke, no stop report, nothing at all", calls.isEmpty())
        assertEquals("the receiver's session is not ended", 0, link.ended)
        assertTrue(h.controller.casting)
        assertEquals("ep1", h.state.value!!.itemId)
        // the cast runs on without a screen: its events reach no one, nothing breaks
        events.onSessionEnded()
        assertNull("nobody to hand the title back to", host.returned)
    }

    @Test fun aScreenOpenedLaterIsItsRemote() {
        val h = hub()
        val first = Host()
        h.attach(first)
        cast(h)
        h.detach(first)
        val second = Host()
        val c = h.attach(second)
        assertTrue(c.casting)
        assertEquals("ep1", c.itemId)
        // only the attached screen hears the cast
        events.onSessionEnded()
        assertEquals("ep1", second.returned)
        assertNull(first.returned)
    }

    @Test fun anOldScreenCannotDetachANewerOne() {
        val h = hub()
        val old = Host(); val now = Host()
        h.attach(old)
        h.attach(now)
        h.detach(old)
        events.onSessionStarted()
        assertEquals(1, now.picked)
        assertEquals(0, old.picked)
    }

    @Test fun logoutAndProfileSwitchStopTheCast() {
        val h = hub()
        h.attach(Host())
        cast(h)
        calls.clear()
        h.stop() // sign-out ([PlayerReset.stopAll]) and "Stop casting"
        assertEquals(listOf("DELETE /api/cast/session/q2", "POST /api/playback/stop", "DELETE /api/cast/session/c1"), calls)
        assertEquals(1, link.ended)
        assertNull(h.state.value)
        assertFalse(h.controller.casting)
    }

    @Test fun anotherProfilesRequestEndsTheCastAndTheSameProfilesDoesNot() {
        val h = hub()
        h.attach(Host())
        h.useProfile("anna")
        cast(h)
        h.noteProfile("anna")
        assertTrue(h.controller.casting)
        calls.clear()
        h.noteProfile("ben") // the server revoked the device's casts on the switch: the TV stops, the stop is still reported
        assertFalse(h.controller.casting)
        assertTrue(calls.contains("DELETE /api/cast/session/c1"))
        assertEquals(1, link.ended)
    }

    @Test fun theHubTicksWhileACastRunsAndStopsWhenItEnds() {
        val h = hub()
        cast(h)
        val before = link.published
        advance(CastHubCore.POLL_MS)
        assertEquals(before + 1, link.published)
        advance(CastHubCore.POLL_MS)
        assertEquals(before + 2, link.published)
        // the controller's own 10 s progress report runs from the tick, with no screen attached
        calls.clear()
        clock += 10_000
        advance(CastHubCore.POLL_MS)
        assertTrue(calls.contains("POST /api/playback/progress"))
        h.stop()
        val after = link.published
        advance(10 * CastHubCore.POLL_MS)
        assertEquals("no ticking without a cast", after, link.published)
    }

    @Test fun theSnapshotFollowsTheReceiver() {
        val h = hub()
        assertNull(h.state.value)
        cast(h)
        events.onState(playing("c1", 120_000))
        val s = h.state.value!!
        assertEquals("Wohnzimmer-TV", s.device)
        assertEquals("Bright Valley", s.title)
        assertEquals("First", s.subtitle)
        assertEquals(120_000L, s.positionMs)
        assertEquals(CastPhase.PLAYING, s.state)
        assertEquals("ep2", s.next!!.itemId)
    }

    @Test fun aCastTheTvKeepsPlayingIsPickedUpAfterARestart() {
        val url = "https://ff.example/media/c/${"A".repeat(43)}/master.m3u8"
        val id = CastIds.ofContentUrl(url)!!
        lookups[id] = CastLookup(id, "ep1", "ms", "ps", clock + 3_600_000, 1_800L * 10_000_000, "chromecast", false, true, "First", "Bright Valley", emptyList())
        val h = hub(custom = true)
        link.playing = ReceiverMedia(null, url)
        assertNull(h.state.value)
        events.onState(playing(id, 600_000))
        assertTrue(h.controller.casting)
        assertEquals("ep1", h.state.value!!.itemId)
        // the own receiver's texts come from the hub: no screen is attached
        assertEquals("from the hub", link.messages.first { it.optString("t") == "ui" }.getJSONObject("strings").getString("next"))
        // one lookup per receiver media, not one per status update
        val lookupsBefore = calls.count { it.startsWith("GET /api/cast/session") }
        events.onState(playing(id, 601_000))
        assertEquals(lookupsBefore, calls.count { it.startsWith("GET /api/cast/session") })
    }

    private fun ours(): Pair<String, String> {
        val url = "https://ff.example/media/c/${"C".repeat(43)}/master.m3u8"
        val id = CastIds.ofContentUrl(url)!!
        lookups[id] = CastLookup(id, "ep1", "ms", "ps", clock + 3_600_000, 1_800L * 10_000_000, "chromecast", false, true, "First", "Bright Valley", emptyList())
        return url to id
    }

    @Test fun adoptingWhileTheScreenPlaysLocallyStopsLocalPlaybackFirstAndOnce() {
        val (url, id) = ours()
        val h = hub(custom = true)
        val host = Host().also { it.local = true }
        h.attach(host)
        link.playing = ReceiverMedia(null, url)
        events.onState(playing(id, 600_000))
        assertTrue(h.controller.casting)
        assertEquals(listOf("stopLocal", "onCasting"), host.order)
        events.onState(playing(id, 601_000))
        assertEquals("once", 1, host.order.count { it == "stopLocal" })
    }

    @Test fun adoptingIntoAnIdleScreenIsUnchanged() {
        val (url, id) = ours()
        val h = hub(custom = true)
        val host = Host()
        h.attach(host)
        link.playing = ReceiverMedia(null, url)
        events.onState(playing(id, 600_000))
        assertTrue(h.controller.casting)
        assertEquals(listOf("onCasting"), host.order)
    }

    @Test fun aStopWhileTheReadoptionLookupIsInFlightStillEndsTheReceiverSession() {
        val (url, id) = ours()
        val h = hub(custom = true)
        link.playing = ReceiverMedia(null, url)
        val queued = mutableListOf<Runnable>()
        stuck = queued // the lookup is on its way
        events.onState(playing(id, 600_000))
        assertFalse(h.controller.casting)
        h.stop() // sign-out meanwhile
        stuck = null
        queued.forEach { it.run() }
        assertFalse("the cast is not adopted after the stop", h.controller.casting)
        assertEquals("the lookup found our cast: the TV session ends with the stop", 1, link.ended)
    }

    @Test fun aStopWhileTheLookupIsInFlightLeavesAForeignCastAlone() {
        val url = "https://ff.example/media/c/${"D".repeat(43)}/master.m3u8"
        val id = CastIds.ofContentUrl(url)!!
        val h = hub(custom = true) // no lookup entry: not ours
        link.playing = ReceiverMedia(null, url)
        val queued = mutableListOf<Runnable>()
        stuck = queued
        events.onState(playing(id, 600_000))
        h.stop()
        stuck = null
        queued.forEach { it.run() }
        assertEquals(0, link.ended)
    }

    @Test fun foreignMediaOnTheTvIsLeftAlone() {
        val url = "https://ff.example/media/c/${"B".repeat(43)}/master.m3u8"
        val h = hub()
        link.playing = ReceiverMedia(null, url)
        events.onState(playing(CastIds.ofContentUrl(url)!!, 1_000)) // lookup answers 404
        assertFalse(h.controller.casting)
        assertNull(h.state.value)
        assertEquals(listOf("GET /api/cast/session/${CastIds.ofContentUrl(url)}"), calls)
        assertEquals(0, link.ended)
    }

    @Test fun theAttachedScreensTextsWinOverTheHubs() {
        val h = hub(custom = true)
        h.attach(Host())
        cast(h)
        assertEquals("from the screen", link.messages.first { it.optString("t") == "ui" }.getJSONObject("strings").getString("next"))
    }

    @Test fun aLookupThatCouldNotBeAnsweredIsTriedAgainAfterThirtySeconds() {
        val url = "https://ff.example/media/c/${"C".repeat(43)}/master.m3u8"
        val id = CastIds.ofContentUrl(url)!!
        down += id
        val h = hub()
        link.playing = ReceiverMedia(null, url)
        events.onState(playing(id, 1_000))
        events.onState(playing(id, 2_000))
        assertEquals("one try per receiver media", 1, calls.count { it.startsWith("GET /api/cast/session") })
        down.clear()
        lookups[id] = CastLookup(id, "ep1", "ms", "ps", clock + 3_600_000, 1_800L * 10_000_000, "chromecast", false, true, "First", "Bright Valley", emptyList())
        advance(CastHubCore.RESUME_RETRY_MS)
        events.onState(playing(id, 3_000))
        assertTrue(h.controller.casting)
    }

    @Test fun theRetryAsksTheReceiverAgainWithoutWaitingForATvEvent() {
        val url = "https://ff.example/media/c/${"D".repeat(43)}/master.m3u8"
        val id = CastIds.ofContentUrl(url)!!
        down += id
        val h = hub()
        link.playing = ReceiverMedia(null, url)
        link.onPublish = { events.onState(playing(id, 4_000)) } // the TV keeps playing and sends no event of its own
        events.onState(playing(id, 1_000))
        down.clear()
        lookups[id] = CastLookup(id, "ep1", "ms", "ps", clock + 3_600_000, 1_800L * 10_000_000, "chromecast", false, true, "First", "Bright Valley", emptyList())
        advance(CastHubCore.RESUME_RETRY_MS)
        assertTrue(h.controller.casting)
    }
}
