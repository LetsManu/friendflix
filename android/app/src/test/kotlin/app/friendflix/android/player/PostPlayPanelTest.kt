// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import app.friendflix.android.R
import app.friendflix.android.downloads.FakeCookies
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.player.panels.PostPlayPanel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
class PostPlayPanelTest {
    private val server = MockWebServer()
    private val routes = ConcurrentHashMap<String, Pair<Int, String>>()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private lateinit var api: PlayerApi
    private lateinit var activity: ControlsTestActivity
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val played = mutableListOf<String>()
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
        routes["GET /api/me"] = 200 to """{"csrfToken":"tok"}"""
        routes["POST /api/postplay/event"] = 204 to ""
        val cookies = FakeCookies().apply { jar[server.url("/").toString().trimEnd('/')] = "ff_sid=s3cret" }
        api = PlayerApi(ServerApi(server.url("/"), OkHttpClient(), cookies), PROFILE)
        activity = Robolectric.buildActivity(ControlsTestActivity::class.java).setup().get()
    }

    @After fun tearDown() { scope.cancel(); server.close() }

    private fun await(done: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!done() && System.currentTimeMillis() < end) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("timed out", done())
    }

    private fun texts(v: View): List<String> =
        if (v is TextView) listOf(v.text.toString()) else if (v is ViewGroup) (0 until v.childCount).flatMap { texts(v.getChildAt(it)) } else emptyList()

    private fun events() = seen.filter { it.method == "POST" && it.url.encodedPath == "/api/postplay/event" }.map { JSONObject(it.body!!.utf8()).toString() }

    private fun panel(data: JSONObject, spoilers: Boolean = false): View =
        PostPlayPanel.build(activity, scope, api, null, data, { played += it }, { opened += it }, spoilerProtection = spoilers)

    private fun item(id: String, name: String, type: String = "Movie", extra: String = "") =
        """{"id":"$id","name":"$name","type":"$type","image":true$extra}"""

    private fun data(state: String, next: String = "null", sequel: String = "null", rows: String = "[]", current: String = item("m1", "Heat"), air: String = "null") =
        JSONObject("""{"state":"$state","current":$current,"next":$next,"nextAirDate":$air,"sequel":$sequel,"canWish":false,"remind":null,"rows":$rows,"hero":null,"suggestions":true}""")

    private val because = """{"kind":"because","title":"Heat","reason":{"seed":{"id":"m1","name":"Heat"}},"items":[${item("m2", "Ronin")},${item("m3", "Collateral")}]}"""

    // ---- when: the card, the end, not wanted, failure (PostPlayFlow) ----

    @Test fun cardAppearsAtPostplayAt() {
        val f = PostPlayFlow("m1", movie = true)
        val at = postplayAtSec(6000.0, emptyList(), emptyList()) // 95 %
        assertFalse(f.card(wanted = true, current = at - 1, atSec = at))
        assertNull(f.fetch(wanted = true, current = at - 1, atSec = at))
        assertTrue(f.card(wanted = true, current = at, atSec = at))
        assertEquals(PostPlayFlow.Fetch.POSTPLAY, f.fetch(wanted = true, current = at, atSec = at))
        assertNull(f.fetch(wanted = true, current = at + 1, atSec = at)) // once
        assertFalse(f.card(wanted = true, current = 10.0, atSec = Double.POSITIVE_INFINITY)) // duration unknown
        f.closeCard()
        assertFalse(f.card(wanted = true, current = at + 2, atSec = at))
    }

    @Test fun endOpensPanel() {
        val f = PostPlayFlow("m1", movie = true)
        f.fetch(true, 5800.0, 5700.0)
        val d = data("movie_end")
        f.loaded(d)
        assertEquals(PostPlayFlow.End.Open(d), f.onEnded(wanted = true))
        f.shown()
        assertFalse(f.card(true, 6000.0, 5700.0)) // the screen is open: no card under it
    }

    @Test fun endInPipIsHeldUntilTheWindowIsExpanded() {
        val f = PostPlayFlow("m1", movie = true)
        f.fetch(true, 5800.0, 5700.0)
        val d = data("movie_end")
        f.loaded(d)
        val end = f.onEnded(wanted = true)
        f.hold(end) // in picture-in-picture: no panel, nothing counted as shown
        assertEquals(PostPlayFlow.End.Open(d), f.release(stillEnded = true)) // expanded at the end: the screen now
        assertNull(f.release(stillEnded = true)) // once
        f.hold(end)
        assertNull(f.release(stillEnded = false)) // replayed meanwhile: dropped
        // "More like this" is held the same way
        val g = PostPlayFlow("m1", movie = true)
        g.fetch(false, 5800.0, 5700.0)
        g.similarLoaded(listOf(Title("a", "A", "Movie", null, null)))
        val more = g.onEnded(wanted = false)
        g.hold(more)
        assertEquals(more, g.release(stillEnded = true))
        g.hold(PostPlayFlow.End.Stay) // only a screen is held
        assertNull(g.release(stillEnded = true))
    }

    @Test fun earlyCardTapWaitsWithTheLoadingText() {
        val f = PostPlayFlow("m1", movie = true)
        f.fetch(true, 5800.0, 5700.0)
        assertNull(f.openCard())
        assertTrue(f.opening)
        val d = data("movie_end")
        assertEquals(PostPlayFlow.End.Open(d), f.loaded(d))
        assertFalse(f.opening)
    }

    @Test fun endBeforeTheAnswerOpensOnceItArrives() {
        val f = PostPlayFlow("m1", movie = true)
        assertEquals(PostPlayFlow.End.Wait, f.onEnded(wanted = true))
        assertEquals(PostPlayFlow.Fetch.POSTPLAY, f.fetch(true, 0.0, Double.POSITIVE_INFINITY)) // the end asks for it
        val d = data("movie_end")
        assertEquals(PostPlayFlow.End.Open(d), f.loaded(d))
    }

    @Test fun castingMeansNoCard() {
        assertFalse(postplayWanted("Movie", hasNextEpisode = false, feature = true, pref = true, casting = true, online = true))
        assertTrue(postplayWanted("Movie", hasNextEpisode = false, feature = true, pref = true, casting = false, online = true))
        assertTrue(postplayWanted("Episode", hasNextEpisode = false, feature = true, pref = true, casting = false, online = true))
        assertFalse(postplayWanted("Episode", hasNextEpisode = true, feature = true, pref = true, casting = false, online = true))
        assertFalse(postplayWanted("Movie", hasNextEpisode = false, feature = false, pref = true, casting = false, online = true))
        assertFalse(postplayWanted("Movie", hasNextEpisode = false, feature = true, pref = false, casting = false, online = true))
        assertFalse(postplayWanted("Movie", hasNextEpisode = false, feature = true, pref = true, casting = false, online = false))
        assertFalse(postplayWanted("Series", hasNextEpisode = false, feature = true, pref = true, casting = false, online = true))
        val f = PostPlayFlow("m1", movie = true)
        assertFalse(f.card(wanted = false, current = 5900.0, atSec = 5700.0))
        assertEquals(PostPlayFlow.End.Stay, PostPlayFlow("e1", movie = false).onEnded(wanted = false)) // an episode: as before
    }

    @Test fun movieWithoutPostplayShowsThreeSimilarSelfExcluded() {
        routes["GET /api/items/m1/similar"] = 200 to """{"items":[${item("m1", "Heat")},${item("a", "A")},${item("b", "B")},${item("c", "C")},${item("d", "D")}]}"""
        val f = PostPlayFlow("m1", movie = true)
        assertEquals(PostPlayFlow.Fetch.SIMILAR, f.fetch(wanted = false, current = 5800.0, atSec = 5700.0))
        assertNull(f.fetch(wanted = false, current = 5801.0, atSec = 5700.0))
        f.similarLoaded(api.similar("m1"))
        val end = f.onEnded(wanted = false)
        assertTrue(end is PostPlayFlow.End.More)
        val titles = (end as PostPlayFlow.End.More).titles
        assertEquals(listOf("a", "b", "c"), titles.map { it.id })
        val v = PostPlayPanel.more(activity, scope, null, titles) { opened += it }
        val row = v.findViewById<ViewGroup>(R.id.postplay_similar)
        assertEquals(3, row.childCount)
        assertTrue(texts(v).containsAll(listOf("A", "B", "C")))
        row.getChildAt(1).performClick()
        assertEquals(listOf("b"), opened)
    }

    @Test fun movieWithoutPostplayOrSimilarStaysOnTheEndedTitle() {
        val f = PostPlayFlow("m1", movie = true)
        f.fetch(false, 5800.0, 5700.0)
        f.similarLoaded(null)
        assertEquals(PostPlayFlow.End.Stay, f.onEnded(wanted = false)) // R9: the player never closes itself
    }

    @Test fun postplayFailureShowsError() {
        val f = PostPlayFlow("m1", movie = true)
        f.fetch(true, 5800.0, 5700.0)
        assertNull(f.loaded(null)) // nothing pending
        assertFalse(f.card(true, 5900.0, 5700.0)) // no card, no empty panel
        assertEquals(PostPlayFlow.End.Stay, f.onEnded(wanted = true)) // no panel; the player stays (R9)
        // a tap on the card while the answer was on its way: the web's error text instead of an empty screen
        val g = PostPlayFlow("m1", movie = true)
        g.fetch(true, 5800.0, 5700.0)
        assertNull(g.openCard())
        assertEquals(PostPlayFlow.End.Failed, g.loaded(null))
    }

    @Test fun postplayRequestFailureIsNull() {
        routes["GET /api/items/m1/postplay"] = 404 to """{"error":"disabled"}"""
        assertNull(api.postplay("m1"))
    }

    // ---- the screen (PostPlayPanel) ----

    @Test fun movieEndHeadlineRowsAndShownEvent() {
        val v = panel(data("movie_end", rows = "[$because]"))
        val t = texts(v)
        assertTrue(t.contains(activity.getString(R.string.player_postplay_just_watched, "Heat")))
        assertTrue(t.contains(activity.getString(R.string.player_postplay_head_movie_end, "Heat")))
        assertTrue(t.contains(activity.getString(R.string.player_postplay_row_because, "Heat")))
        assertTrue(t.containsAll(listOf("Ronin", "Collateral")))
        assertNull(v.findViewById<View>(R.id.postplay_play))
        await { events().isNotEmpty() }
        assertEquals("""{"type":"shown","state":"movie_end"}""", events().single())
    }

    @Test fun nextPartPlaysInThePlayerWithAPlayEvent() {
        val cont = """{"kind":"continuation","title":"Heat Saga","reason":{},"items":[${item("m9", "Heat 2")}]}"""
        val v = panel(data("next", next = item("m9", "Heat 2"), rows = "[$cont]"))
        assertTrue(texts(v).contains(activity.getString(R.string.player_postplay_head_next_part, "Heat Saga", "Heat 2")))
        val play = v.findViewById<TextView>(R.id.postplay_play)
        assertEquals(activity.getString(R.string.player_postplay_play_title, "Heat 2"), play.text.toString())
        play.performClick()
        assertEquals(listOf("m9"), played)
        await { events().size == 2 }
        assertEquals("""{"type":"play","row":"continuation"}""", events()[1])
        PostPlayPanel.closed(v) // closed by the play: no dismiss
        shadowOf(Looper.getMainLooper()).idle()
        Thread.sleep(200)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(2, events().size)
    }

    @Test fun gapJumpsBackAndCaughtUpSaysTheDate() {
        val ep = item("e3", "Three", "Episode", ""","indexNumber":3,"parentIndexNumber":1,"seriesName":"Show"""")
        val cur = item("e5", "Five", "Episode", ""","seriesName":"Show"""")
        val v = panel(data("gap", next = ep, current = cur))
        assertTrue(texts(v).contains(activity.getString(R.string.player_postplay_head_gap, "3")))
        assertTrue(texts(v).contains(activity.getString(R.string.player_postplay_sub_gap, "Show")))
        assertEquals(activity.getString(R.string.player_postplay_jump_back, "3"), v.findViewById<TextView>(R.id.postplay_play).text.toString())
        val c = panel(data("caught_up", current = cur))
        assertTrue(texts(c).contains(activity.getString(R.string.player_postplay_head_caught_up)))
        assertTrue(texts(c).any { it.startsWith(activity.getString(R.string.player_postplay_sub_caught_up, "Show")) && it.endsWith(activity.getString(R.string.player_postplay_sub_no_date)) })
    }

    @Test fun seriesFinishedOffersTheSequel() {
        val cur = item("e9", "Finale", "Episode", ""","seriesName":"Show"""")
        val v = panel(data("series_finished", sequel = item("m7", "The Movie"), current = cur))
        assertTrue(texts(v).contains(activity.getString(R.string.player_postplay_head_series_finished, "Show")))
        v.findViewById<View>(R.id.postplay_play).performClick()
        assertEquals(listOf("m7"), played)
    }

    @Test fun aTitleOpensItsPageAnEpisodePlays() {
        val eps = """{"kind":"taste","title":"","reason":{},"items":[${item("e1", "Pilot", "Episode", ""","indexNumber":1,"parentIndexNumber":1""")}]}"""
        val v = panel(data("movie_end", rows = "[$because,$eps]"), spoilers = true)
        val rows = v.findViewById<ViewGroup>(R.id.postplay_rows)
        val first = (rows.getChildAt(0) as ViewGroup).findViewById<ViewGroup>(R.id.postplay_row_items)
        first.getChildAt(0).performClick()
        assertEquals(listOf("m2"), opened)
        assertTrue(texts(v).contains(activity.getString(R.string.player_postplay_episode, "1", "1", "Pilot")))
        val epTile = (rows.getChildAt(1) as ViewGroup).findViewById<ViewGroup>(R.id.postplay_row_items).getChildAt(0)
        assertEquals(activity.getString(R.string.player_postplay_spoiler), epTile.findViewById<View>(R.id.pp_image).contentDescription) // unwatched: no picture
        epTile.performClick()
        assertEquals(listOf("e1"), played)
        await { events().size == 3 }
        assertEquals(listOf("""{"type":"click","row":"because"}""", """{"type":"play","row":"taste"}"""), events().drop(1))
    }

    @Test fun backToTheTitleAndCloseSendDismiss() {
        var back = 0
        val v = PostPlayPanel.build(activity, scope, api, null, data("movie_end"), { played += it }, { opened += it }, onBack = { back++ })
        v.findViewById<View>(R.id.postplay_back).performClick()
        assertEquals(1, back)
        PostPlayPanel.closed(v)
        await { events().size == 2 }
        assertEquals("""{"type":"dismiss"}""", events()[1])
    }

    @Test fun nothingToSuggestSaysSo() {
        val v = panel(data("movie_end"))
        assertTrue(texts(v).contains(activity.getString(R.string.player_postplay_empty)))
    }
}
