// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.media3.session.MediaSessionService
import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.cast.CastHost
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.TestEnv
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The real player screen against a fake server ([TestEnv]): what a title's load keeps when the server's answers fail or a newer
 * title replaced it, and what a new intent resets (the profile's sound mode). Playback itself ends on the error box (no stream).
 */
@RunWith(RobolectricTestRunner::class)
class PlayerActivityServerTest {
    @get:Rule val tmp = TemporaryFolder()
    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var env: TestEnv
    private var ac: ActivityController<PlayerActivity>? = null
    private val routes = ConcurrentHashMap<String, Pair<Int, String>>()
    /** paths whose answer waits for this latch */
    private val held = ConcurrentHashMap<String, CountDownLatch>()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private val done = CopyOnWriteArrayList<String>()

    @Before fun setUp() {
        env = TestEnv(tmp.newFolder())
        routes["GET /api/me"] = 200 to """{"csrfToken":"tok","profile":{"id":"$PROFILE"}}"""
        env.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val path = request.url.encodedPath
                held[path]?.await(10, TimeUnit.SECONDS)
                val (code, body) = routes["${request.method} $path"] ?: (404 to """{"error":"not_found"}""")
                done += path
                return MockResponse.Builder().code(code).addHeader("content-type", "application/json").body(body).build()
            }
        }
        shadowOf(context as Application).declareActionUnbindable(MediaSessionService.SERVICE_INTERFACE)
    }

    @After fun tearDown() {
        held.values.forEach { it.countDown() }
        ac?.let { if (!it.get().isFinishing) it.get().finish() }
        shadowOf(Looper.getMainLooper()).idle()
        env.close()
    }

    private fun intent(item: String, token: String, profile: String = PROFILE) = Intent(context, PlayerActivity::class.java)
        .putExtra(PlayerActivity.EXTRA_ITEM, item)
        .putExtra(PlayerActivity.EXTRA_PROFILE, profile)
        .putExtra(PlayerActivity.EXTRA_TOKEN, token)

    private fun launch(i: Intent): PlayerActivity {
        val c = Robolectric.buildActivity(PlayerActivity::class.java, i).setup()
        ac = c
        return c.get()
    }

    private fun infos(item: String) = seen.count { it.url.encodedPath == "/api/playback/info" && it.body?.utf8()?.contains("\"itemId\":\"$item\"") == true }

    /** runs the main looper until [cond] holds (the requests run on the IO dispatcher) */
    private fun await(cond: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!cond() && System.currentTimeMillis() < end) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("timed out; seen=${seen.map { it.url.encodedPath }}", cond())
    }

    private fun settle() { repeat(30) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) } }

    private fun field(a: PlayerActivity, name: String): Any? =
        PlayerActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(a)

    // ---- the sound mode (controller ruling R2) ----

    @Test fun aFailedPrefsLoadKeepsTheStoredSoundMode() {
        FxStore.save(context, PROFILE, "night")
        routes["GET /api/prefs"] = 500 to """{"error":"x"}"""
        val a = launch(intent("it1", "t1"))
        await { infos("it1") == 1 } // the title's load is through (prefs failed)
        assertEquals("night", field(a, "fxMode"))
        assertEquals("night", FxStore.load(context, PROFILE))
    }

    @Test fun loadedPrefsReplaceTheStoredSoundMode() {
        FxStore.save(context, PROFILE, "night")
        routes["GET /api/prefs"] = 200 to """{"prefs":{"audioFx":"voices"}}"""
        val a = launch(intent("it1", "t1"))
        await { infos("it1") == 1 }
        assertEquals("voices", field(a, "fxMode"))
        assertEquals("voices", FxStore.load(context, PROFILE))
    }

    @Test fun aNewIntentForAnotherProfileTakesThatProfilesSoundMode() {
        FxStore.save(context, PROFILE, "night")
        FxStore.save(context, "p2", "voices")
        routes["GET /api/prefs"] = 500 to """{"error":"x"}"""
        val a = launch(intent("it1", "t1"))
        await { infos("it1") == 1 }
        ac!!.newIntent(intent("it2", "t2", profile = "p2"))
        await { infos("it2") == 1 }
        assertEquals("voices", field(a, "fxMode"))
        assertEquals("night", FxStore.load(context, PROFILE))
        assertEquals("voices", FxStore.load(context, "p2"))
    }

    @Test fun aNewIntentLetsTheServersSoundModeWinAgain() {
        routes["GET /api/prefs"] = 200 to """{"prefs":{"audioFx":"off"}}"""
        val a = launch(intent("it1", "t1"))
        await { infos("it1") == 1 }
        PlayerActivity::class.java.getDeclaredMethod("changeFx", String::class.java).apply { isAccessible = true }.invoke(a, "both")
        assertEquals(true, field(a, "fxTouched"))
        routes["GET /api/prefs"] = 200 to """{"prefs":{"audioFx":"voices"}}"""
        ac!!.newIntent(intent("it2", "t2"))
        await { infos("it2") == 1 }
        assertEquals("voices", field(a, "fxMode")) // a switch flipped for the last title no longer holds the server's mode back
    }

    // ---- a superseded load writes nothing ----

    @Test fun aLoadReplacedByANewTitleLeavesItsStateAlone() {
        routes["GET /api/items/it1"] = 200 to """{"item":{"id":"it1","type":"Episode","name":"One","seriesName":"S","seriesId":"s1","parentIndexNumber":1,"indexNumber":1}}"""
        routes["GET /api/items/it1/next"] = 200 to """{"item":{"id":"it1b","type":"Episode","name":"Two","seriesName":"S","seriesId":"s1","parentIndexNumber":1,"indexNumber":2}}"""
        val langPref = CountDownLatch(1)
        held["/api/series/s1/langpref"] = langPref
        val a = launch(intent("it1", "t1"))
        await { seen.any { it.url.encodedPath == "/api/series/s1/langpref" } } // it1's load waits for the series' languages
        ac!!.newIntent(intent("it2", "t2")) // it2: no such title on the server, no next episode
        await { infos("it2") == 1 }
        val langs = field(a, "langs")
        langPref.countDown() // it1's answer arrives after all
        await { done.contains("/api/series/s1/langpref") }
        settle()
        assertNull(field(a, "nextItem"))
        assertNull(field(a, "item"))
        assertTrue(langs === field(a, "langs"))
        assertEquals(0, infos("it1"))
    }

    // ---- back from the TV ----

    @Test fun aReturnFromTheTvAfterATitleSwitchStartsNothing() {
        val a = launch(intent("it1", "t1"))
        await { infos("it1") == 1 }
        val items = seen.count { it.url.encodedPath == "/api/items/it1" }
        val host = field(a, "castHost") as CastHost
        host.onReturn("it1", 5_000L, play = true, ended = false)
        Players.reports.submit {}.get(5, TimeUnit.SECONDS) // the hand-back is posted after the reports thread's queue
        ac!!.newIntent(intent("it2", "t2")) // a new title before the hand-back ran
        await { infos("it2") == 1 }
        settle()
        assertEquals(items, seen.count { it.url.encodedPath == "/api/items/it1" })
        assertEquals(1, infos("it1"))
    }
}
