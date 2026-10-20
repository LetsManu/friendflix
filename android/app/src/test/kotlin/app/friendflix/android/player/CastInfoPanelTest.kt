// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.friendflix.android.R
import app.friendflix.android.downloads.FakeCookies
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.player.panels.CastInfoPanel
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
class CastInfoPanelTest {
    private val server = MockWebServer()
    private val routes = ConcurrentHashMap<String, Pair<Int, String>>()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private lateinit var api: PlayerApi
    private lateinit var images: ImageLoader
    private lateinit var activity: ControlsTestActivity
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val opened = mutableListOf<String>()

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val (code, body) = routes["${request.method} ${request.url.encodedPath}"] ?: (404 to """{"error":"not_found"}""")
                return MockResponse.Builder().code(code).addHeader("content-type", "application/json").body(body).build()
            }
        }
        server.start()
        val cookies = FakeCookies().apply { jar[server.url("/").toString().trimEnd('/')] = "ff_sid=s3cret" }
        val sapi = ServerApi(server.url("/"), OkHttpClient(), cookies)
        api = PlayerApi(sapi, PROFILE)
        images = ImageLoader(sapi)
        activity = Robolectric.buildActivity(ControlsTestActivity::class.java).setup().get()
    }

    @After fun tearDown() { scope.cancel(); server.close() }

    private val full = """{"item":{"id":"it1","name":"Pilot","type":"Episode","year":2020,"rating":"TV-14","communityRating":8.4},
        "cast":[{"id":"p1","name":"Ann","image":false,"role":"Hero"},{"id":"p2","name":"Bob","image":false}],
        "guests":[{"id":"p3","name":"Cy","image":false}],"directors":[{"id":"p4","name":"Di","image":false}],
        "writers":[],"creators":[],"studios":["Studio One","Studio Two"],"genres":["Drama","Sci-Fi"]}"""

    private fun panel(id: String = "it1"): View = CastInfoPanel.build(activity, scope, api, images, id) { opened += it }

    private fun await(done: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!done() && System.currentTimeMillis() < end) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("timed out", done())
    }

    private fun texts(v: View): List<String> =
        if (v is TextView) listOf(v.text.toString()) else if (v is ViewGroup) (0 until v.childCount).flatMap { texts(v.getChildAt(it)) } else emptyList()

    private fun byDescription(v: View, d: String): View? {
        if (v.contentDescription?.toString() == d) return v
        if (v is ViewGroup) for (i in 0 until v.childCount) byDescription(v.getChildAt(i), d)?.let { return it }
        return null
    }

    private fun s(id: Int, vararg a: Any) = activity.getString(id, *a)

    @Test fun sectionsRenderOnlyWhenNonEmpty() {
        routes["GET /api/items/it1/castinfo"] = 200 to full
        val v = panel()
        await { texts(v).contains("Pilot") }
        val t = texts(v)
        assertTrue(t.contains("2020") || t.any { it.contains("2020") })
        assertTrue(t.any { it.contains("TV-14") })
        for (h in listOf(R.string.player_info_cast, R.string.player_info_guests, R.string.player_info_directors, R.string.player_info_studio, R.string.player_info_genres)) {
            assertTrue(s(h), t.contains(s(h)))
        }
        assertFalse(t.contains(s(R.string.player_info_writers)))
        assertFalse(t.contains(s(R.string.player_info_creators)))
        assertTrue(t.contains("Ann"))
        assertTrue(t.contains(s(R.string.player_info_as, "Hero")))
        assertTrue(t.contains("Studio One, Studio Two"))
        assertTrue(t.contains("Drama, Sci-Fi"))
    }

    @Test fun noPeopleSaysNone() {
        routes["GET /api/items/it1/castinfo"] = 200 to """{"item":{"id":"it1","name":"Film","type":"Movie"}}"""
        val v = panel()
        await { texts(v).contains("Film") }
        assertTrue(texts(v).contains(s(R.string.player_info_none)))
        assertFalse(texts(v).contains(s(R.string.player_info_cast)))
    }

    @Test fun personTapLoadsTheirTitlesAndBackReturns() {
        routes["GET /api/items/it1/castinfo"] = 200 to full
        routes["GET /api/people/p1"] = 200 to """{"person":{"id":"p1","name":"Ann"},"items":[
            {"id":"it1","name":"Pilot","type":"Episode","image":false},{"id":"m1","name":"Film","type":"Movie","year":1999,"image":false}]}"""
        val v = panel()
        await { texts(v).contains("Ann") }
        byDescription(v, s(R.string.player_info_person, "Ann"))!!.performClick()
        await { texts(v).contains("Film (1999)") }
        assertTrue(seen.any { it.url.encodedPath == "/api/people/p1" })
        assertTrue(texts(v).contains(s(R.string.player_info_person_more, "Ann")))
        assertTrue(texts(v).contains(s(R.string.player_info_person_role, "Hero")))
        assertFalse(texts(v).contains("Pilot (2020)")) // the playing title is not offered again
        assertFalse(texts(v).contains("Bob")) // the cast list is replaced
        v.findViewById<View>(R.id.info_back).performClick()
        assertTrue(texts(v).contains("Bob"))
        assertNull(v.findViewById<View>(R.id.info_back))
    }

    @Test fun titleTapOpensIt() {
        routes["GET /api/items/it1/castinfo"] = 200 to full
        routes["GET /api/people/p2"] = 200 to """{"items":[{"id":"m1","name":"Film","type":"Movie","year":1999,"image":false}]}"""
        val v = panel()
        await { texts(v).contains("Bob") }
        byDescription(v, s(R.string.player_info_person, "Bob"))!!.performClick()
        await { texts(v).contains("Film (1999)") }
        val row = byDescription(v, "Film (1999)")
        assertNotNull(row)
        row!!.performClick()
        assertEquals(listOf("m1"), opened)
    }

    @Test fun personWithoutTitlesAndFailureSayTheirText() {
        routes["GET /api/items/it1/castinfo"] = 200 to full
        routes["GET /api/people/p1"] = 200 to """{"items":[]}"""
        routes["GET /api/people/p2"] = 500 to """{"error":"x"}"""
        val v = panel()
        await { texts(v).contains("Ann") }
        byDescription(v, s(R.string.player_info_person, "Ann"))!!.performClick()
        await { texts(v).contains(s(R.string.player_info_person_none)) }
        v.findViewById<View>(R.id.info_back).performClick()
        byDescription(v, s(R.string.player_info_person, "Bob"))!!.performClick()
        await { texts(v).contains(s(R.string.player_info_person_failed)) }
    }

    @Test fun castInfoFailureShowsError() {
        routes["GET /api/items/it1/castinfo"] = 503 to """{"error":"x"}"""
        val v = panel()
        await { texts(v).contains(s(R.string.player_info_failed)) }
        assertFalse(texts(v).contains(s(R.string.player_info_loading)))
    }

    // ---- through the player bar ----

    @Test fun barOpensItForTheCurrentItemAndATitleSwitchClosesIt() {
        routes["GET /api/items/cast9/castinfo"] = 200 to full
        val view = activity.findViewById<PlayerView>(R.id.player_view)
        val player = ExoPlayer.Builder(activity).build()
        try {
            view.player = player
            val host = ExtrasTestHost(player)
            val controls = PlayerControls(activity, view, player, host)
            val button = view.findViewById<View>(R.id.player_info)
            assertEquals(View.GONE, button.visibility)
            controls.openInfo() // nothing loaded yet
            assertFalse(controls.panel.isOpen)
            host.infoSource = InfoSource(api, images, "cast9") // while casting: the TV's title
            controls.showInfoButton(true)
            assertEquals(View.VISIBLE, button.visibility)
            button.performClick()
            assertTrue(controls.panel.isOpen)
            await { seen.any { it.url.encodedPath == "/api/items/cast9/castinfo" } }
            controls.newTitle()
            assertFalse(controls.panel.isOpen)
            assertEquals(View.GONE, button.visibility)
            host.offline = true
            controls.showInfoButton(true)
            assertEquals(View.GONE, button.visibility) // hidden offline
        } finally {
            player.release()
        }
    }
}
