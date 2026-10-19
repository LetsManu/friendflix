// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.setup

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ServerProbeTest {
    private lateinit var server: MockWebServer
    private val probe = ServerProbe(OkHttpClient(), appVersion = "2.0.0")

    @Before fun start() { server = MockWebServer().also { it.start() } }
    @After fun stop() { server.close() }

    private fun run(body: String, code: Int = 200): ProbeResult {
        server.enqueue(MockResponse.Builder().code(code).body(body).build())
        return runBlocking { probe.probe(server.url("/")) }
    }

    private fun json(version: String = "2.0.0", extra: String = "") =
        """{"sha":"abc1234","version":"$version","codename":"Brezel","build":"release","channel":"stable","label":"$version"$extra}"""

    @Test fun compatibleServer() {
        assertEquals(ProbeResult.Ok("2.0.0"), run(json()))
        assertEquals("/api/version", server.takeRequest().url.encodedPath)
    }

    @Test fun newerServerIsFine() = assertEquals(ProbeResult.Ok("2.1.0"), run(json("2.1.0")))

    @Test fun missingMinAndroidMeansCompatible() = assertTrue(run(json()) is ProbeResult.Ok)

    @Test fun appOlderThanMinAndroid() =
        assertEquals(ProbeResult.AppTooOld, run(json(extra = ""","minAndroid":"2.0.1"""")))

    @Test fun appEqualToMinAndroidIsFine() = assertTrue(run(json(extra = ""","minAndroid":"2.0.0"""")) is ProbeResult.Ok)

    @Test fun serverOlderThanMinServer() = assertEquals(ProbeResult.ServerTooOld, run(json("1.9.9")))

    @Test fun versionsCompareNumerically() {
        assertEquals(ProbeResult.AppTooOld, run(json(extra = ""","minAndroid":"2.0.10"""")))
        assertEquals(ProbeResult.ServerTooOld, run(json("1.9.99")))
    }

    @Test fun notJsonOrWrongShape() {
        assertEquals(ProbeResult.NotFriendFlix, run("<html>hi</html>"))
        assertEquals(ProbeResult.NotFriendFlix, run("""{"version":"2.0.0"}"""))
        assertEquals(ProbeResult.NotFriendFlix, run("""{"sha":"x","version":"banana","codename":"c"}"""))
        assertEquals(ProbeResult.NotFriendFlix, run("[]"))
    }

    @Test fun errorStatusIsNotFriendFlix() = assertEquals(ProbeResult.NotFriendFlix, run(json(), code = 404))

    @Test fun redirectIsNotFollowed() {
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://evil.test/").build())
        assertEquals(ProbeResult.NotFriendFlix, runBlocking { probe.probe(server.url("/")) })
    }

    @Test fun unreachable() {
        val url = server.url("/")
        server.close()
        assertEquals(ProbeResult.Unreachable, runBlocking { probe.probe(url) })
    }

    @Test fun semverCompare() {
        assertTrue(Semver.parse("2.0.0")!! < Semver.parse("2.0.1")!!)
        assertTrue(Semver.parse("1.99.99")!! < Semver.parse("2.0.0")!!)
        assertEquals(null, Semver.parse("2.0"))
        assertEquals(null, Semver.parse("2.0.0-rc1"))
    }
}
