// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.bridge

import android.net.Uri
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

    private fun send(msg: String, from: Uri = origin, main: Boolean = true, sink: Sink = reply) = bridge.onMessage(msg, from, main, sink)
    private fun call(method: String, args: String = "{}", id: String = "r1") = send("""{"id":"$id","method":"$method","args":$args}""")

    @Test fun capabilitiesReflectWiring() {
        call("capabilities")
        val r = reply.sent.single()
        assertEquals("r1", r.getString("id"))
        assertTrue(r.getBoolean("ok"))
        val res = r.getJSONObject("result")
        assertEquals(1, res.getInt("api"))
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
        downloads.entries = listOf(DownloadEntry("L-1", "i-1", "downloading", 0.5, 1234L, 1_900_000_000_000L))
        call("downloads")
        val e = reply.sent.single().getJSONArray("result").getJSONObject(0)
        assertEquals("L-1", e.getString("licenseId"))
        assertEquals("i-1", e.getString("itemId"))
        assertEquals("downloading", e.getString("state"))
        assertEquals(0.5, e.getDouble("progress"), 0.0)
        assertEquals(1234L, e.getLong("bytes"))
        assertEquals(1_900_000_000_000L, e.getLong("expiresAt"))
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
        }, downloads, Capabilities(true, true, false), {})
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
}
