// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.friendflix.android.R
import app.friendflix.android.downloads.FakeCookies
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.player.panels.EpisodesPanel
import app.friendflix.android.player.panels.EpisodesSource
import app.friendflix.android.player.panels.TracksActions
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
class EpisodesPanelTest {
    private val server = MockWebServer()
    private val routes = ConcurrentHashMap<String, Pair<Int, String>>()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private lateinit var api: PlayerApi
    private lateinit var images: ImageLoader
    private lateinit var activity: ControlsTestActivity
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val picked = mutableListOf<String>()

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val q = request.url.queryParameter("seasonId")?.let { "?seasonId=$it" } ?: ""
                val (code, body) = routes["${request.method} ${request.url.encodedPath}$q"] ?: (404 to """{"error":"not_found"}""")
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

    private val twoSeasons = """{"items":[{"id":"s1","name":"Season 1","indexNumber":1},{"id":"s2","name":"Season 2","indexNumber":2}]}"""
    private fun eps(vararg e: String) = """{"items":[${e.joinToString(",")}]}"""
    private fun ep(id: String, s: Int, n: Int, name: String, runMin: Long = 45, posMin: Long = 0, played: Boolean = false) =
        """{"id":"$id","name":"$name","parentIndexNumber":$s,"indexNumber":$n,"runtimeTicks":${runMin * 600_000_000},"positionTicks":${posMin * 600_000_000},"played":$played}"""

    private fun panel(season: Int?, current: String, cache: EpisodesPanel.Cache = EpisodesPanel.Cache()): View =
        EpisodesPanel.build(activity, scope, api, images, "ser", season, current, cache) { picked += it }

    private fun await(done: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!done() && System.currentTimeMillis() < end) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("timed out", done())
    }

    private fun texts(v: View): List<String> =
        if (v is TextView) listOf(v.text.toString()) else if (v is ViewGroup) (0 until v.childCount).flatMap { texts(v.getChildAt(it)) } else emptyList()

    private fun list(v: View): ViewGroup = v.findViewById(R.id.episodes_list)
    private fun tabs(v: View): ViewGroup = v.findViewById(R.id.episodes_seasons)
    private fun msg(v: View): TextView = v.findViewById(R.id.episodes_msg)
    private fun episodeRequests() = seen.filter { it.url.encodedPath.endsWith("/episodes") }

    @Test fun currentSeasonIsPreselected() {
        routes["GET /api/items/ser/seasons"] = 200 to twoSeasons
        routes["GET /api/items/ser/episodes?seasonId=s2"] = 200 to eps(ep("e21", 2, 1, "Return"), ep("e22", 2, 2, "Storm"))
        val v = panel(season = 2, current = "e22")
        await { list(v).childCount == 2 }
        assertEquals(listOf("s2"), episodeRequests().map { it.url.queryParameter("seasonId") })
        assertEquals(2, tabs(v).childCount)
        assertFalse(tabs(v).getChildAt(0).isSelected)
        assertTrue(tabs(v).getChildAt(1).isSelected)
        val row = list(v).getChildAt(1)
        assertTrue(texts(row).contains(activity.getString(R.string.player_episode_code, 2, 2)))
        assertTrue(texts(row).contains("Storm"))
        assertTrue(row.isSelected) // the playing mark
        assertTrue(texts(row).contains(activity.getString(R.string.player_episodes_playing) + " · " + activity.getString(R.string.player_minutes, 45)))
        assertFalse(list(v).getChildAt(0).isSelected)
    }

    @Test fun unknownCurrentSeasonPicksTheFirst() {
        routes["GET /api/items/ser/seasons"] = 200 to twoSeasons
        routes["GET /api/items/ser/episodes?seasonId=s1"] = 200 to eps(ep("e11", 1, 1, "Pilot"))
        val v = panel(season = null, current = "x")
        await { list(v).childCount == 1 }
        assertEquals(listOf("s1"), episodeRequests().map { it.url.queryParameter("seasonId") })
        assertTrue(tabs(v).getChildAt(0).isSelected)
    }

    @Test fun noSeasonsLoadsAllEpisodesWithoutSeasonId() {
        routes["GET /api/items/ser/seasons"] = 200 to """{"items":[]}"""
        routes["GET /api/items/ser/episodes"] = 200 to eps(ep("e1", 1, 1, "One"), ep("e2", 1, 2, "Two"), ep("e3", 1, 3, "Three"))
        val v = panel(season = 1, current = "e1")
        await { list(v).childCount == 3 }
        assertEquals(1, episodeRequests().size)
        assertNull(episodeRequests()[0].url.queryParameter("seasonId"))
        assertEquals(View.GONE, tabs(v).visibility)
    }

    @Test fun episodesFailureShowsError() {
        routes["GET /api/items/ser/seasons"] = 200 to twoSeasons
        routes["GET /api/items/ser/episodes?seasonId=s1"] = 502 to """{"error":"x"}"""
        val v = panel(season = 1, current = "e11")
        await { msg(v).text.toString() == activity.getString(R.string.player_episodes_failed) }
        assertEquals(View.VISIBLE, msg(v).visibility)
        assertEquals(0, list(v).childCount)
    }

    @Test fun failedSeasonsStillListAllEpisodes() {
        routes["GET /api/items/ser/seasons"] = 500 to """{"error":"x"}"""
        routes["GET /api/items/ser/episodes"] = 200 to eps(ep("e1", 1, 1, "One"))
        val v = panel(season = 1, current = "e1")
        await { list(v).childCount == 1 }
    }

    @Test fun emptySeasonSaysNoEpisodes() {
        routes["GET /api/items/ser/seasons"] = 200 to twoSeasons
        routes["GET /api/items/ser/episodes?seasonId=s1"] = 200 to eps()
        val v = panel(season = 1, current = "e1")
        await { msg(v).text.toString() == activity.getString(R.string.player_episodes_none) }
    }

    @Test fun rowsShowRuntimeAndProgressAndPlayedAsFinished() {
        routes["GET /api/items/ser/seasons"] = 200 to """{"items":[{"id":"s1","name":"Season 1","indexNumber":1}]}"""
        routes["GET /api/items/ser/episodes?seasonId=s1"] = 200 to eps(
            ep("a", 1, 1, "Seen", played = true), ep("b", 1, 2, "Half", runMin = 40, posMin = 20), ep("c", 1, 3, "New", runMin = 65),
        )
        val v = panel(season = 1, current = "zzz")
        await { list(v).childCount == 3 }
        val bars = (0 until 3).map { list(v).getChildAt(it).findViewById<ProgressBar>(R.id.ep_progress) }
        assertEquals(View.VISIBLE, bars[0].visibility)
        assertEquals(100, bars[0].progress)
        assertEquals(50, bars[1].progress)
        assertEquals(View.GONE, bars[2].visibility)
        assertTrue(texts(list(v).getChildAt(2)).contains(activity.getString(R.string.player_duration_hm, 1, 5)))
        assertTrue(texts(list(v).getChildAt(1)).contains(activity.getString(R.string.player_minutes, 40)))
        // a single season: its name as the heading, no tabs
        assertEquals(View.GONE, tabs(v).visibility)
        assertTrue(texts(v).contains("Season 1"))
    }

    @Test fun tabSwitchLoadsThatSeasonAndATapPicks() {
        routes["GET /api/items/ser/seasons"] = 200 to twoSeasons
        routes["GET /api/items/ser/episodes?seasonId=s1"] = 200 to eps(ep("e11", 1, 1, "Pilot"))
        routes["GET /api/items/ser/episodes?seasonId=s2"] = 200 to eps(ep("e21", 2, 1, "Return"), ep("e22", 2, 2, "Storm"))
        val v = panel(season = 1, current = "e11")
        await { list(v).childCount == 1 }
        tabs(v).getChildAt(1).performClick()
        await { list(v).childCount == 2 }
        assertTrue(tabs(v).getChildAt(1).isSelected)
        list(v).getChildAt(1).performClick()
        assertEquals(listOf("e22"), picked)
    }

    @Test fun resultsAreCachedPerSeries() {
        routes["GET /api/items/ser/seasons"] = 200 to twoSeasons
        routes["GET /api/items/ser/episodes?seasonId=s1"] = 200 to eps(ep("e11", 1, 1, "Pilot"))
        val cache = EpisodesPanel.Cache()
        val v1 = panel(season = 1, current = "e11", cache = cache)
        await { list(v1).childCount == 1 }
        val before = seen.size
        val v2 = panel(season = 1, current = "e11", cache = cache)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, list(v2).childCount)
        assertEquals(before, seen.size)
        assertEquals("Pilot", cache.find("e11")?.name)
        assertEquals(null, cache.find("nope"))
    }

    @Test fun episodesAreOfferedOnlyForOnlineEpisodesOfASeries() {
        assertTrue(EpisodesPanel.offered(type = "Episode", seriesId = "ser", offline = false))
        assertFalse(EpisodesPanel.offered(type = "Episode", seriesId = null, offline = false))
        assertFalse(EpisodesPanel.offered(type = "Movie", seriesId = null, offline = false))
        assertFalse(EpisodesPanel.offered(type = "Episode", seriesId = "ser", offline = true))
    }

    // ---- through the player bar (PlayerControls) ----

    /** the player screen's side as PlayerActivity has it: a pick goes through [TitleSwitch], which owns the per-title reset */
    private class Host(val local: Player, val source: () -> EpisodesSource?) : PlayerControls.Host {
        val played = mutableListOf<String>()
        val onTv = mutableListOf<String>()
        var casting = false
        /** the title on show is an episode of a series (the activity's EpisodesPanel.offered) */
        var offered = true
        lateinit var controls: PlayerControls
        private val switch = TitleSwitch(object : TitleSwitch.Steps {
            override fun newTitle() = controls.newTitle()
            override fun casting() = casting
            override fun playOnTv(id: String) { onTv += id }
            override fun cancelLoad() {}
            override fun resetLocal() {}
            override fun startOnline(id: String) { played += id }
        })
        var pip = false
        override fun active(): Player = local
        override fun casting() = casting
        override fun offline() = false
        override fun inPip() = pip
        override fun flash(text: String, ms: Long) {}
        override fun pipSupported() = true
        override fun enterPip() {}
        override fun pauseActive() { local.pause() }
        override fun tracks() = null
        override val tracksActions = object : TracksActions {
            override fun audio(t: AudioTrack) {}
            override fun subtitle(index: Int?) {}
            override fun search() {}
            override fun fx(mode: String) {}
        }
        override fun qualities(): List<Pair<String, Long>>? = null
        override fun quality() = 0L
        override fun changeQuality(bps: Long) {}
        override fun episodes() = if (offered) source() else null
        override fun playItem(id: String) = switch.play(id)
    }

    @Test fun pickResetsTitleState() {
        routes["GET /api/items/ser/seasons"] = 200 to twoSeasons
        routes["GET /api/items/ser/episodes?seasonId=s1"] = 200 to eps(ep("e11", 1, 1, "Pilot"), ep("e12", 1, 2, "Next"))
        val view = activity.findViewById<PlayerView>(R.id.player_view)
        val player = ExoPlayer.Builder(activity).build()
        try {
            view.player = player
            val host = Host(player) { EpisodesSource(api, images, "ser", 1, "e11") }
            val controls = PlayerControls(activity, view, player, host)
            host.controls = controls
            controls.updateBar()
            assertEquals(View.VISIBLE, view.findViewById<View>(R.id.player_episodes).visibility)
            controls.setSpeed(1.5f)
            controls.sleep.setAfterEpisode()
            view.findViewById<View>(R.id.player_episodes).performClick()
            assertTrue(controls.panel.isOpen)
            val content = activity.findViewById<View>(R.id.player_panel_content)
            await { content.findViewById<ViewGroup>(R.id.episodes_list)?.childCount == 2 }
            // the playing one only closes the panel
            content.findViewById<ViewGroup>(R.id.episodes_list).getChildAt(0).performClick()
            assertFalse(controls.panel.isOpen)
            assertEquals(emptyList<String>(), host.played)
            assertEquals(1.5f, player.playbackParameters.speed)
            controls.openEpisodes()
            await { activity.findViewById<View>(R.id.player_panel_content).findViewById<ViewGroup>(R.id.episodes_list)?.childCount == 2 }
            activity.findViewById<View>(R.id.player_panel_content).findViewById<ViewGroup>(R.id.episodes_list).getChildAt(1).performClick()
            assertFalse(controls.panel.isOpen)
            assertEquals(listOf("e12"), host.played)
            assertEquals(1f, player.playbackParameters.speed)
            assertFalse(controls.sleep.afterEpisode) // "after this episode" was meant for the one left
            host.offered = false
            controls.updateBar()
            assertEquals(View.GONE, view.findViewById<View>(R.id.player_episodes).visibility)
            host.pip = true
            controls.openEpisodes()
            assertFalse(controls.panel.isOpen)
        } finally {
            player.release()
        }
    }

    @Test fun aPickWhileCastingStartsTheTv() {
        routes["GET /api/items/ser/seasons"] = 200 to twoSeasons
        routes["GET /api/items/ser/episodes?seasonId=s1"] = 200 to eps(ep("e11", 1, 1, "Pilot"), ep("e12", 1, 2, "Next"))
        val view = activity.findViewById<PlayerView>(R.id.player_view)
        val player = ExoPlayer.Builder(activity).build()
        try {
            view.player = player
            val host = Host(player) { EpisodesSource(api, images, "ser", 1, "e11") }
            host.casting = true
            val controls = PlayerControls(activity, view, player, host)
            host.controls = controls
            controls.updateBar()
            val button = view.findViewById<View>(R.id.player_episodes)
            assertEquals(View.VISIBLE, button.visibility) // Episodes stays while casting
            button.performClick()
            val content = activity.findViewById<View>(R.id.player_panel_content)
            await { content.findViewById<ViewGroup>(R.id.episodes_list)?.childCount == 2 }
            content.findViewById<ViewGroup>(R.id.episodes_list).getChildAt(1).performClick()
            assertEquals(listOf("e12"), host.onTv) // on the TV, never locally
            assertEquals(emptyList<String>(), host.played)
        } finally {
            player.release()
        }
    }
}
