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
        override fun report(kind: PlaybackReporter.Kind, body: JSONObject) { calls += "POST /api/playback/${kind.path}" }
        override fun next(itemId: String): ItemInfo? = ItemInfo("ep2", "Episode", "Second", "Bright Valley", "s1", 1, 2)
        override fun segments(itemId: String): List<Segment> = emptyList()
    }

    private class FakeLink(override val custom: Boolean) : CastLink {
        var ended = 0
        var published = 0
        var playing: ReceiverMedia? = null
        val messages = mutableListOf<JSONObject>()
        override val connected = true
        override val deviceName: String? = "Wohnzimmer-TV"
        override fun load(info: CastInfo, subIndex: Int?, autoplay: Boolean) {}
        override fun queue(info: CastInfo, autoplay: Boolean) = true
        override fun dequeue(castId: String) {}
        override fun send(msg: JSONObject) { messages += msg }
        override fun end() { ended++ }
        override fun current() = playing
        override fun publish() { published++ }
        override fun release() {}
    }

    private class Host : CastHost {
        var returned: String? = null
        var picked = 0
        var casting = 0
        override fun stopLocal() {}
        override fun onCasting(itemId: String) { casting++ }
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
        still = StillWatching { clock },
        io = direct, main = direct, now = { clock },
        schedule = { ms, block -> val c = BooleanArray(1); timers += Triple(clock + ms, block, c); ({ c[0] = true }) },
        strings = { JSONObject().put("next", "from the hub") },
    )

    private fun info(castId: String) = CastInfo(
        castId = castId, expiresAt = clock + 60 * 60_000, playSessionId = "ps-$castId", mediaSourceId = "ms-$castId",
        runtimeTicks = 30L * 60 * 10_000_000, startTime = 60, contentUrl = "https://ff.example/media/c/$castId/master.m3u8",
        contentType = "application/x-mpegURL", hlsSegmentFormat = "ts", title = "First", seriesName = "Bright Valley", imageUrl = null,
        subtitles = emptyList(), report = "rt-$castId",
    )

    private fun cast(h: CastHubCore, itemId: String = "ep1") {
        val c = h.controller
        assertTrue(c.start(CastStart(itemId, 60_000, null, null, 8_000_000, 8_000_000, true, FlowPrefs(), offline = false)))
        events.onState(playing("c1", 61_000))
    }

    private fun playing(castId: String, positionMs: Long) = ReceiverState(
        castId = castId, loaded = true, playing = true, paused = false, positionMs = positionMs, durationMs = 30 * 60_000, idle = false,
    )

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
}
