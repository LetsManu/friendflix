// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.app.Activity
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.Spinner
import android.widget.TextView
import app.friendflix.android.R
import app.friendflix.android.downloads.FakeCookies
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.player.panels.SubtitleSearchPanel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
class SubtitleSearchPanelTest {
    private val server = MockWebServer()
    private val routes = ConcurrentHashMap<String, Pair<Int, String>>()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private lateinit var api: PlayerApi
    private lateinit var activity: Activity
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var added = 0

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val (code, body) = routes["${request.method} ${request.url.encodedPath}"] ?: (404 to """{"error":"not_found"}""")
                return MockResponse.Builder().code(code).addHeader("content-type", "application/json").body(body).build()
            }
        }
        server.start()
        routes["GET /api/me"] = 200 to """{"csrfToken":"tok"}"""
        val cookies = FakeCookies().apply { jar[server.url("/").toString().trimEnd('/')] = "ff_sid=s3cret" }
        api = PlayerApi(ServerApi(server.url("/"), OkHttpClient(), cookies), PROFILE)
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.setTheme(R.style.Theme_FriendFlix_Player)
    }

    @After fun tearDown() { scope.cancel(); server.close() }

    private fun panel(lang: String = "eng"): View = SubtitleSearchPanel.build(activity, scope, api, "it1", lang) { added++ }

    private fun <T : View> View.find(id: Int): T = findViewById(id)

    /** runs the main looper until [done] holds (the requests run on the IO dispatcher) */
    private fun await(done: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!done() && System.currentTimeMillis() < end) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("timed out", done())
    }

    private fun texts(v: View): List<String> =
        if (v is TextView) listOf(v.text.toString()) else if (v is ViewGroup) (0 until v.childCount).flatMap { texts(v.getChildAt(it)) } else emptyList()

    private fun search(v: View) { v.find<Button>(R.id.subs_go).performClick() }

    @Test fun resultsRenderNameProviderAndDownloads() {
        routes["GET /api/items/it1/subtitles/search"] = 200 to """{"results":[{"id":"a","name":"Movie.en.srt","provider":"OpenSubtitles","downloads":42},{"id":"b","name":"Other.srt","provider":"Podnapisi","downloads":0}]}"""
        val v = panel()
        search(v)
        await { v.find<ViewGroup>(R.id.subs_results).childCount == 2 }
        val all = texts(v.find(R.id.subs_results))
        assertTrue(all.contains("Movie.en.srt"))
        assertTrue(all.contains("OpenSubtitles · 42×"))
        assertTrue(all.contains("Podnapisi"))
        assertEquals("eng", seen.last { it.url.encodedPath.endsWith("/search") }.url.queryParameter("lang"))
    }

    @Test fun languageDefaultsToTheGivenOneAndIsSent() {
        routes["GET /api/items/it1/subtitles/search"] = 200 to """{"results":[]}"""
        val v = panel("ger")
        val sp = v.find<Spinner>(R.id.subs_lang)
        assertEquals(5, sp.adapter.count)
        assertEquals(0, sp.selectedItemPosition)
        sp.setSelection(3) // spa
        search(v)
        await { seen.any { it.url.encodedPath.endsWith("/search") } }
        assertEquals("spa", seen.last { it.url.encodedPath.endsWith("/search") }.url.queryParameter("lang"))
    }

    @Test fun subtitleSearchFailureShowsError() {
        routes["GET /api/items/it1/subtitles/search"] = 403 to """{"error":"forbidden"}"""
        val v = panel()
        search(v)
        await { v.find<TextView>(R.id.subs_msg).visibility == View.VISIBLE }
        assertEquals(activity.getString(R.string.player_subs_not_allowed), v.find<TextView>(R.id.subs_msg).text.toString())
        routes["GET /api/items/it1/subtitles/search"] = 502 to """{"error":"x"}"""
        search(v)
        await { v.find<TextView>(R.id.subs_msg).text.toString() == activity.getString(R.string.player_subs_provider_down) }
        assertEquals(0, v.find<ViewGroup>(R.id.subs_results).childCount)
        assertEquals(0, added)
    }

    @Test fun emptyResultsShowNotFound() {
        routes["GET /api/items/it1/subtitles/search"] = 200 to """{"results":[]}"""
        val v = panel()
        search(v)
        await { v.find<TextView>(R.id.subs_msg).visibility == View.VISIBLE }
        assertEquals(activity.getString(R.string.player_subs_not_found), v.find<TextView>(R.id.subs_msg).text.toString())
    }

    @Test fun downloadSuccessCallsOnAddedOnce() {
        routes["GET /api/items/it1/subtitles/search"] = 200 to """{"results":[{"id":"a","name":"Movie.en.srt","provider":"P","downloads":1}]}"""
        routes["POST /api/items/it1/subtitles/download"] = 200 to """{"ok":true}"""
        val v = panel()
        search(v)
        await { v.find<ViewGroup>(R.id.subs_results).childCount == 1 }
        v.find<ViewGroup>(R.id.subs_results).getChildAt(0).performClick()
        await { added == 1 }
        assertTrue(seen.last { it.method == "POST" }.body!!.utf8().contains("\"subtitleId\":\"a\""))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, added)
    }

    @Test fun downloadFailureShowsErrorAndKeepsResults() {
        routes["GET /api/items/it1/subtitles/search"] = 200 to """{"results":[{"id":"a","name":"Movie.en.srt","provider":"P","downloads":1}]}"""
        routes["POST /api/items/it1/subtitles/download"] = 502 to """{"error":"x"}"""
        val v = panel()
        search(v)
        await { v.find<ViewGroup>(R.id.subs_results).childCount == 1 }
        v.find<ViewGroup>(R.id.subs_results).getChildAt(0).performClick()
        await { v.find<TextView>(R.id.subs_msg).text.toString() == activity.getString(R.string.player_subs_download_failed) }
        assertEquals(0, added)
        assertEquals(1, v.find<ViewGroup>(R.id.subs_results).childCount)
        assertTrue(v.find<Button>(R.id.subs_go).isEnabled)
        assertTrue(v.find<ViewGroup>(R.id.subs_results).getChildAt(0).isEnabled)
    }
}
