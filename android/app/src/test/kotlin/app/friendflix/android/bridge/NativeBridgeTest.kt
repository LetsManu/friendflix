// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.bridge

import android.net.Uri
import app.friendflix.android.cast.CastKind
import app.friendflix.android.cast.CastPhase
import app.friendflix.android.cast.CastSnapshot
import app.friendflix.android.cast.NextSnapshot
import app.friendflix.android.shell.OriginPolicy
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NativeBridgeTest {
    private class FakeLauncher(var result: Boolean = true) : PlayerLauncher {
        val calls = mutableListOf<PlayRequest>()
        override fun launch(req: PlayRequest): Boolean { calls += req; return result }
    }

    private class FakeSink(var result: Boolean = true) : DownloadSink {
        val enqueued = mutableListOf<DownloadRequest>()
        val deleted = mutableListOf<String>()
        var entries = listOf<DownloadEntry>()
        override fun enqueue(req: DownloadRequest): Boolean { enqueued += req; return result }
        override fun list(): List<DownloadEntry> = entries
        override fun delete(licenseId: String): Boolean { deleted += licenseId; return result }
    }

    private class Sink : ReplySink {
        val sent = mutableListOf<JSONObject>()
        override fun post(json: String) { sent += JSONObject(json) }
    }

    private val origin = Uri.parse("https://friend.example.com")
    private val launcher = FakeLauncher()
    private val downloads = FakeSink()
    private var settingsOpened = 0
    private val bridge = NativeBridge(
        OriginPolicy("https://friend.example.com".toHttpUrl()), launcher, downloads,
        Capabilities(play = true, download = true, cast = false), openSettings = { settingsOpened++ },
    )
    private val reply = Sink()

    private class FakeCast : CastRemote {
        var snap: CastSnapshot? = null
        var opened = true
        val calls = mutableListOf<String>()
        override fun snapshot() = snap
        override fun playPause() { calls += "playPause" }
        override fun next() { calls += "next" }
        override fun stop() { calls += "stop" }
        override fun open(): Boolean { calls += "open"; return opened }
        override fun sessionChanged(profileId: String?) { calls += "session:$profileId" }
    }

    private val cast = FakeCast()
    private var clockMs = 10_000L
    private val castBridge = NativeBridge(
        OriginPolicy("https://friend.example.com".toHttpUrl()), launcher, downloads,
        Capabilities(play = true, download = true, cast = true, castBar = true), cast = cast, clock = { clockMs }, openSettings = {},
    )

    private fun snapshot(position: Long = 1_000, paused: Boolean = false, next: NextSnapshot? = null, title: String = "Moonlit Harbour") = CastSnapshot(
        kind = CastKind.CHROMECAST, device = "Living room", itemId = "item-1", title = title, subtitle = null, posterId = "item-1",
        isEpisode = false, positionMs = position, durationMs = 600_000, paused = paused, state = CastPhase.PLAYING, next = next,
    )

    private fun castCall(method: String, args: String = "{}", id: String = "c1") {
        castBridge.onMessage("""{"id":"$id","method":"$method","args":$args}""", origin, true, reply)
    }

    private fun send(msg: String, from: Uri = origin, main: Boolean = true, sink: Sink = reply) = bridge.onMessage(msg, from, main, sink)
    private fun call(method: String, args: String = "{}", id: String = "r1") = send("""{"id":"$id","method":"$method","args":$args}""")

    @Test fun capabilitiesReflectWiring() {
        call("capabilities")
        val r = reply.sent.single()
        assertEquals("r1", r.getString("id"))
        assertTrue(r.getBoolean("ok"))
        val res = r.getJSONObject("result")
        assertEquals(2, res.getInt("api"))
        assertFalse(res.getBoolean("castBar"))
        assertTrue(res.getBoolean("play"))
        assertTrue(res.getBoolean("download"))
        assertFalse(res.getBoolean("cast"))
    }

    @Test fun validPlayReachesTheLauncher() {
        call("play", """{"itemId":"abc-123","profileId":"p-1","startMs":90000,"mediaSourceId":"ms1","audio":"de","subtitle":"en"}""")
        assertEquals(listOf(PlayRequest("abc-123", "p-1", 90000L, "ms1", "de", "en")), launcher.calls)
        assertEquals(true, reply.sent.single().getBoolean("result"))
    }

    @Test fun playOptionalsMayBeMissing() {
        call("play", """{"itemId":"a","profileId":"p"}""")
        assertEquals(PlayRequest("a", "p", null, null, null, null), launcher.calls.single())
    }

    @Test fun launcherRefusalIsAFalseResult() {
        launcher.result = false
        call("play", """{"itemId":"a","profileId":"p"}""")
        val r = reply.sent.single()
        assertTrue(r.getBoolean("ok"))
        assertFalse(r.getBoolean("result"))
    }

    @Test fun validDownloadReachesTheSink() {
        call("download", """{"licenseId":"L-1","itemId":"i-1","profileId":"p-1"}""")
        assertEquals(listOf(DownloadRequest("L-1", "i-1", "p-1")), downloads.enqueued)
        assertEquals(true, reply.sent.single().getBoolean("result"))
    }

    @Test fun downloadsListsEntries() {
        downloads.entries = listOf(DownloadEntry("L-1", "i-1", "downloading", 0.5, 1234L, 1_900_000_000_000L, title = "Alpha", profileId = "p-1"))
        call("downloads")
        val e = reply.sent.single().getJSONArray("result").getJSONObject(0)
        assertEquals("L-1", e.getString("licenseId"))
        assertEquals("i-1", e.getString("itemId"))
        assertEquals("downloading", e.getString("state"))
        assertEquals(0.5, e.getDouble("progress"), 0.0)
        assertEquals(1234L, e.getLong("bytes"))
        assertEquals(1_900_000_000_000L, e.getLong("expiresAt"))
        assertEquals("Alpha", e.getString("title"))
        assertEquals("p-1", e.getString("profileId"))
    }

    @Test fun deleteDownloadGoesToTheSink() {
        call("deleteDownload", """{"licenseId":"L-9"}""")
        assertEquals(listOf("L-9"), downloads.deleted)
        assertEquals(true, reply.sent.single().getBoolean("result"))
    }

    @Test fun openSettingsCallsBack() {
        call("openSettings")
        assertEquals(1, settingsOpened)
        assertTrue(reply.sent.single().getBoolean("ok"))
    }

    private fun assertRejected(msg: String, expectedId: String? = "r1") {
        val r = reply.sent.single()
        assertFalse("expected ok:false for $msg", r.getBoolean("ok"))
        if (expectedId == null) assertTrue(r.isNull("id")) else assertEquals(expectedId, r.getString("id"))
        assertTrue(launcher.calls.isEmpty())
        assertTrue(downloads.enqueued.isEmpty())
        assertTrue(downloads.deleted.isEmpty())
        assertEquals(0, settingsOpened)
    }

    @Test fun otherOriginIsRejected() {
        send("""{"id":"r1","method":"play","args":{"itemId":"a","profileId":"p"}}""", from = Uri.parse("https://evil.test"))
        assertRejected("evil")
    }

    @Test fun lookalikeAndWrongPortOriginsAreRejected() {
        for (o in listOf("https://friend.example.com.evil.test", "https://friend.example.com:8443", "http://friend.example.com", "null")) {
            reply.sent.clear()
            send("""{"id":"r1","method":"openSettings","args":{}}""", from = Uri.parse(o))
            assertRejected(o)
        }
    }

    @Test fun theSignInPageOriginIsRejectedLikeAnyOther() {
        // the shell lets the server's identity provider into the main frame; the bridge stays app-origin only
        send("""{"id":"r1","method":"downloads","args":{}}""", from = Uri.parse("https://auth.example.com"))
        assertRejected("auth")
    }

    @Test fun subFramesAreRejected() {
        send("""{"id":"r1","method":"play","args":{"itemId":"a","profileId":"p"}}""", main = false)
        assertRejected("subframe")
    }

    @Test fun rejectedFramesNeverBecomeTheEventTarget() {
        val evil = Sink()
        send("""{"id":"r1","method":"capabilities","args":{}}""", from = Uri.parse("https://evil.test"), sink = evil)
        send("""{"id":"r1","method":"capabilities","args":{}}""", main = false, sink = evil)
        bridge.emit("download", JSONObject().put("licenseId", "L"))
        assertEquals(2, evil.sent.size) // only the two error replies
    }

    @Test fun invalidIdsAreRejected() {
        for (bad in listOf("../x", "a/b", "", "a".repeat(65), "a b", "a\u0000", "é")) {
            reply.sent.clear()
            call("play", JSONObject().put("itemId", bad).put("profileId", "p").toString())
            assertRejected("itemId=$bad")
        }
        reply.sent.clear()
        call("play", """{"itemId":"a","profileId":"../p"}""")
        assertRejected("profileId")
        reply.sent.clear()
        call("download", """{"licenseId":"a;b","itemId":"i","profileId":"p"}""")
        assertRejected("licenseId")
        reply.sent.clear()
        call("deleteDownload", """{"licenseId":"../../x"}""")
        assertRejected("delete id")
    }

    @Test fun invalidNumbersAreRejected() {
        for (bad in listOf("-1", "1e30", "999999999999", "\"5\"", "true", "[]")) {
            reply.sent.clear()
            call("play", """{"itemId":"a","profileId":"p","startMs":$bad}""")
            assertRejected("startMs=$bad")
        }
        reply.sent.clear()
        call("play", """{"itemId":"a","profileId":"p","startMs":-1}""")
        assertRejected("startMs=-1")
    }

    @Test fun unknownKeysAndMethodsAreRejected() {
        call("play", """{"itemId":"a","profileId":"p","evil":1}""")
        assertRejected("extra arg")
        reply.sent.clear()
        call("eval")
        assertRejected("unknown method")
        reply.sent.clear()
        send("""{"id":"r1","method":"capabilities","args":{},"extra":1}""")
        assertRejected("extra top-level key")
        reply.sent.clear()
        call("capabilities", """{"x":1}""")
        assertRejected("args on capabilities")
    }

    @Test fun missingRequiredArgsAreRejected() {
        call("play", """{"itemId":"a"}""")
        assertRejected("no profile")
        reply.sent.clear()
        call("download", """{"licenseId":"a","itemId":"i"}""")
        assertRejected("no profile in download")
    }

    @Test fun wrongTypesAreRejected() {
        call("play", """{"itemId":5,"profileId":"p"}""")
        assertRejected("numeric itemId")
        reply.sent.clear()
        send("""{"id":"r1","method":"play","args":[1]}""")
        assertRejected("array args")
    }

    @Test fun malformedAndOversizedPayloadsAreRejected() {
        send("not json")
        assertRejected("garbage", null)
        reply.sent.clear()
        send("""{"id":"r1","method":"play","args":{"itemId":"a","profileId":"p","audio":"${"x".repeat(5000)}"}}""")
        assertTrue(reply.sent.single().isNull("id") || reply.sent.single().getString("id") == "r1")
        assertFalse(reply.sent.single().getBoolean("ok"))
        assertTrue(launcher.calls.isEmpty())
        reply.sent.clear()
        send("""{"id":"bad id!","method":"capabilities","args":{}}""")
        assertRejected("bad request id", null)
    }

    @Test fun eventsGoToTheLatestMainFrameReplyTarget() {
        val first = Sink()
        val second = Sink()
        send("""{"id":"r1","method":"capabilities","args":{}}""", sink = first)
        send("""{"id":"r2","method":"capabilities","args":{}}""", sink = second)
        bridge.emit("download", JSONObject().put("licenseId", "L-1").put("state", "done"))
        assertEquals(1, first.sent.size)
        val ev = second.sent.last()
        assertEquals("download", ev.getString("event"))
        assertEquals("L-1", ev.getJSONObject("detail").getString("licenseId"))
        assertFalse(ev.has("id"))
    }

    @Test fun emitWithoutAPageDoesNothing() {
        bridge.emit("download", JSONObject()) // no reply target yet: must not throw
    }

    @Test fun throwingBackendBecomesAnError() {
        val b = NativeBridge(OriginPolicy("https://friend.example.com".toHttpUrl()), object : PlayerLauncher {
            override fun launch(req: PlayRequest): Boolean = error("boom")
        }, downloads, Capabilities(true, true, false), openSettings = {})
        b.onMessage("""{"id":"r1","method":"play","args":{"itemId":"a","profileId":"p"}}""", origin, true, reply)
        assertFalse(reply.sent.single().getBoolean("ok"))
    }

    @Test fun stubsRefuse() {
        assertFalse(NoPlayerLauncher.launch(PlayRequest("a", "p", null, null, null, null)))
        assertFalse(NoDownloadSink.enqueue(DownloadRequest("l", "i", "p")))
        assertTrue(NoDownloadSink.list().isEmpty())
        assertFalse(NoDownloadSink.delete("l"))
    }

    @Test fun foreignFramesLearnNothingAboutSizeOrSyntax() {
        send("x".repeat(5000), from = Uri.parse("https://evil.test"))
        send("not json", main = false)
        assertEquals(listOf("forbidden", "forbidden"), reply.sent.map { it.getString("error") })
    }

    @Test fun detachStopsEvents() {
        send("""{"id":"r1","method":"capabilities","args":{}}""")
        bridge.detach()
        bridge.emit("download", JSONObject())
        assertEquals(1, reply.sent.size)
    }
    @Test fun downloadChangesBecomeEvents() {
        call("capabilities")
        reply.sent.clear()
        val a = DownloadEntry("L-1", "I-1", "downloading", 0.5, 50, 9)
        val b = DownloadEntry("L-2", "I-2", "queued", 0.0, 0, 9)
        bridge.emitDownloadChanges(emptyList(), listOf(a, b))
        assertEquals(listOf("L-1", "L-2"), reply.sent.map { it.getJSONObject("detail").getString("licenseId") })
        assertEquals(0.5, reply.sent[0].getJSONObject("detail").getDouble("progress"), 0.0)
        reply.sent.clear()
        bridge.emitDownloadChanges(listOf(a, b), listOf(a.copy(state = "done", progress = 1.0)))
        assertEquals(2, reply.sent.size)
        assertEquals("download", reply.sent[0].getString("event"))
        assertEquals("done", reply.sent[0].getJSONObject("detail").getString("state"))
        assertEquals("downloadRemoved", reply.sent[1].getString("event"))
        assertEquals("L-2", reply.sent[1].getJSONObject("detail").getString("licenseId"))
        reply.sent.clear()
        bridge.emitDownloadChanges(listOf(a), listOf(a)) // unchanged: nothing
        assertTrue(reply.sent.isEmpty())
        bridge.emitDownloadChanges(listOf(a), listOf(a.copy(state = "error", error = "noSpace")))
        assertEquals("noSpace", reply.sent.single().getJSONObject("detail").getString("error"))
        reply.sent.clear()
        bridge.emitDownloadChanges(emptyList(), listOf(a))
        assertFalse(reply.sent.single().getJSONObject("detail").has("error")) // no reason: no key
    }

    // ---- Task 30: cast bar ----

    @Test fun capabilitiesAnnounceTheCastBar() {
        castCall("capabilities")
        assertTrue(reply.sent.single().getJSONObject("result").getBoolean("castBar"))
    }

    @Test fun castStateReturnsTheHubSnapshot() {
        cast.snap = snapshot(next = NextSnapshot("item-2", "S1 E2"))
        castCall("castState")
        val r = reply.sent.single().getJSONObject("result")
        assertEquals("chromecast", r.getString("kind"))
        assertEquals("Living room", r.getString("device"))
        assertEquals("item-1", r.getString("itemId"))
        assertEquals("Moonlit Harbour", r.getString("title"))
        assertFalse(r.has("subtitle"))
        assertEquals("item-1", r.getString("posterId"))
        assertFalse(r.getBoolean("isEpisode"))
        assertEquals(1_000, r.getLong("positionMs"))
        assertEquals(600_000, r.getLong("durationMs"))
        assertFalse(r.getBoolean("paused"))
        assertEquals("playing", r.getString("state"))
        assertEquals("item-2", r.getJSONObject("next").getString("itemId"))
        assertEquals("S1 E2", r.getJSONObject("next").getString("label"))
        reply.sent.clear()
        cast.snap = null
        castCall("castState")
        assertTrue(reply.sent.single().isNull("result"))
        assertTrue(reply.sent.single().getBoolean("ok"))
        reply.sent.clear()
        castCall("castState", """{"x":1}""")
        assertEquals("bad_args", reply.sent.single().getString("error"))
    }

    @Test fun castControlRejectsUnknownActions() {
        for (args in listOf("""{"action":"rewind"}""", """{"action":"PLAYPAUSE"}""", """{"action":5}""", """{}""", """{"action":"stop","x":1}""", """{"action":null}""")) {
            reply.sent.clear()
            castCall("castControl", args)
            assertEquals(args, "bad_args", reply.sent.single().getString("error"))
        }
        assertTrue(cast.calls.isEmpty())
    }

    @Test fun castControlRoutesTheActions() {
        castCall("castControl", """{"action":"playPause"}""")
        castCall("castControl", """{"action":"next"}""")
        castCall("castControl", """{"action":"open"}""")
        assertEquals(listOf("playPause", "next", "open"), cast.calls)
        assertTrue(reply.sent.all { it.getBoolean("ok") && it.getBoolean("result") })
        reply.sent.clear()
        cast.opened = false
        castCall("castControl", """{"action":"open"}""")
        assertFalse(reply.sent.single().getBoolean("result"))
    }

    @Test fun stopRoutesToCastHubStop() {
        castCall("castControl", """{"action":"stop"}""")
        assertEquals(listOf("stop"), cast.calls)
        assertTrue(reply.sent.single().getBoolean("ok"))
    }

    @Test fun castControlFromAForeignFrameIsForbidden() {
        castBridge.onMessage("""{"id":"c1","method":"castControl","args":{"action":"stop"}}""", Uri.parse("https://evil.test"), true, reply)
        castBridge.onMessage("""{"id":"c2","method":"castControl","args":{"action":"stop"}}""", origin, false, reply)
        assertEquals(listOf("forbidden", "forbidden"), reply.sent.map { it.getString("error") })
        assertTrue(cast.calls.isEmpty())
    }

    @Test fun castEventsAreThrottledToOnePerSecondForPositionOnlyChanges() {
        castCall("capabilities")
        reply.sent.clear()
        castBridge.emitCast(snapshot(position = 1_000))
        assertEquals(1, reply.sent.size)
        assertEquals("cast", reply.sent[0].getString("event"))
        clockMs += 300
        castBridge.emitCast(snapshot(position = 1_300)) // position only, too soon
        assertEquals(1, reply.sent.size)
        clockMs += 700
        castBridge.emitCast(snapshot(position = 2_000)) // a second later
        assertEquals(2, reply.sent.size)
        assertEquals(2_000, reply.sent[1].getJSONObject("detail").getLong("positionMs"))
        clockMs += 10
        castBridge.emitCast(snapshot(position = 2_010, paused = true)) // anything else changes at once
        assertEquals(3, reply.sent.size)
        assertTrue(reply.sent[2].getJSONObject("detail").getBoolean("paused"))
        clockMs += 10
        castBridge.emitCast(snapshot(position = 2_020, paused = true, title = "Other")) // so does a new title
        assertEquals(4, reply.sent.size)
        castBridge.emitCast(snapshot(position = 2_020, paused = true, title = "Other")) // identical: nothing
        assertEquals(4, reply.sent.size)
    }

    @Test fun theEndOfTheCastIsAnEventWithNullDetail() {
        castCall("capabilities")
        reply.sent.clear()
        castBridge.emitCast(snapshot())
        clockMs += 5
        castBridge.emitCast(null) // never throttled
        assertEquals(2, reply.sent.size)
        assertEquals("cast", reply.sent[1].getString("event"))
        assertTrue(reply.sent[1].isNull("detail"))
        castBridge.emitCast(null) // still none: nothing new
        assertEquals(2, reply.sent.size)
    }

    // ---- S7: the cast follows the web session ----

    @Test fun profileSwitchIsHandedToTheCast() {
        castCall("sessionChanged", """{"profileId":"profile-2"}""")
        assertEquals(listOf("session:profile-2"), cast.calls)
        assertTrue(reply.sent.single().getBoolean("ok"))
    }

    @Test fun logoutEndsTheCast() {
        castCall("sessionChanged", """{"profileId":null}""")
        assertEquals(listOf("session:null"), cast.calls)
        assertTrue(reply.sent.single().getBoolean("ok"))
    }

    @Test fun sessionChangedIsValidated() {
        for (args in listOf("{}", """{"profileId":"bad id!"}""", """{"profileId":7}""", """{"profileId":"a","x":1}""")) {
            reply.sent.clear()
            castCall("sessionChanged", args)
            assertEquals(args, "bad_args", reply.sent.single().getString("error"))
        }
        assertTrue(cast.calls.isEmpty())
    }
}
