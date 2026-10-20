// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import app.friendflix.android.downloads.FakeCookies
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.SessionExpired
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
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** The player's extra server calls (episodes, chapters, cast, bookmarks, subtitle search …) against a MockWebServer. */
@RunWith(RobolectricTestRunner::class)
class PlayerApiExtrasTest {
    private val server = MockWebServer()
    private val routes = ConcurrentHashMap<String, Pair<Int, String>>()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private lateinit var api: PlayerApi

    @Before fun setUp() {
        routes["GET /api/me"] = 200 to """{"csrfToken":"tok"}"""
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val key = "${request.method} ${request.url.encodedPath}"
                val (code, body) = routes[key] ?: (404 to """{"error":"not_found"}""")
                return MockResponse.Builder().code(code).addHeader("content-type", "application/json").body(body).build()
            }
        }
        server.start()
        val cookies = FakeCookies().apply { jar[server.url("/").toString().trimEnd('/')] = "ff_sid=s3cret" }
        api = PlayerApi(ServerApi(server.url("/"), OkHttpClient(), cookies), PROFILE)
    }

    @After fun tearDown() { server.close() }

    private fun last(method: String, path: String) = seen.last { it.method == method && it.url.encodedPath == path }

    @Test fun capsReadsFlagsFeaturesAndRole() {
        routes["GET /api/me"] = 200 to """{"csrfToken":"tok","role":"guest","server":{"capabilities":{"chapters":false,"trickplay":true,"subtitleSearch":false,"segments":["intro","Outro"]}},"features":{"postplay":false}}"""
        val c = api.caps()
        assertFalse(c.chapters)
        assertTrue(c.trickplay)
        assertFalse(c.subtitleSearch)
        assertFalse(c.postplay)
        assertEquals(setOf("intro", "outro"), c.segments)
        assertEquals("guest", c.role)
        assertEquals(setOf("intro", "outro"), api.segmentTypes())
    }

    @Test fun capsOfAnEmptyMeAreAllTrue() {
        routes["GET /api/me"] = 200 to "{}"
        assertEquals(ServerCaps(), api.caps())
        assertTrue(api.caps().chapters && api.caps().trickplay && api.caps().subtitleSearch && api.caps().postplay)
        assertEquals(PlayerApi.ALL_SEGMENTS, api.segmentTypes())
    }

    @Test fun capsOfAFailedMeAreAllTrue() {
        routes["GET /api/me"] = 500 to "{}"
        assertEquals(ServerCaps(), api.caps())
    }

    @Test fun prefsReadAudioFxAnimeAndPostplay() {
        routes["GET /api/prefs"] = 200 to """{"prefs":{"audioFx":"night","animeOriginal":true,"postplay":false}}"""
        val p = api.prefs()
        assertEquals("night", p.audioFx)
        assertTrue(p.animeOriginal)
        assertFalse(p.postplay)
        routes["GET /api/prefs"] = 200 to """{"prefs":{"audioFx":"bogus"}}"""
        assertEquals(PlayerPrefs(), api.prefs())
    }

    @Test fun parseInfoReadsTrickplay() {
        val base = JSONObject("""{"playSessionId":"ps","mediaSourceId":"m","directUrl":"/d","resumeTicks":0,"maxBitrate":1,"audioTracks":[],"subtitles":[]}""")
        assertNull(PlayerApi.parseInfo(base)!!.trickplay)
        base.put("trickplay", JSONObject("""{"width":320,"height":180,"tileWidth":10,"tileHeight":10,"count":240,"interval":10000,"url":"/media/tp/{n}.jpg"}"""))
        assertEquals(TrickplayInfo(320, 180, 10, 10, 240, 10_000L, "/media/tp/{n}.jpg"), PlayerApi.parseInfo(base)!!.trickplay)
        base.put("trickplay", JSONObject("""{"width":320}"""))
        assertNull(PlayerApi.parseInfo(base)!!.trickplay)
    }

    @Test fun seasonsAndEpisodes() {
        routes["GET /api/items/s1/seasons"] = 200 to """{"items":[{"id":"se1","name":"Season 1","indexNumber":1},{"id":"se0","name":"Specials"}]}"""
        assertEquals(listOf(Season("se1", "Season 1", 1), Season("se0", "Specials", null)), api.seasons("s1"))
        routes["GET /api/items/s1/episodes"] = 200 to """{"items":[
            {"id":"e1","name":"Pilot","parentIndexNumber":1,"indexNumber":2,"image":true,"runtimeTicks":27000000000,"positionTicks":100,"played":true},
            {"id":"e2","name":"Two","image":false,"played":false}]}"""
        val eps = api.episodes("s1", "se1")!!
        assertEquals("se1", last("GET", "/api/items/s1/episodes").url.queryParameter("seasonId"))
        assertEquals(Episode("e1", "Pilot", 1, 2, "/media/Items/e1/Images/Primary?maxWidth=400&quality=85", 27_000_000_000L, 100L, true), eps[0])
        assertEquals(Episode("e2", "Two", null, null, null, 0L, 0L, false), eps[1])
        api.episodes("s1", null)
        assertNull(last("GET", "/api/items/s1/episodes").url.queryParameter("seasonId"))
    }

    @Test fun seasonsFailureIsNull() {
        routes["GET /api/items/s1/seasons"] = 500 to "{}"
        assertNull(api.seasons("s1"))
        assertNull(api.episodes("s1", null)) // 404
    }

    @Test fun chapters() {
        routes["GET /api/items/i1/chapters"] = 200 to """{"supported":true,"chapters":[{"start":0,"name":"Intro","image":"/media/c0.jpg"},{"start":61.5,"name":"Two"}]}"""
        assertEquals(listOf(Chapter(0.0, "Intro", "/media/c0.jpg"), Chapter(61.5, "Two", null)), api.chapters("i1"))
        routes["GET /api/items/i1/chapters"] = 200 to """{"supported":false,"chapters":[]}"""
        assertEquals(emptyList<Chapter>(), api.chapters("i1"))
        routes["GET /api/items/i1/chapters"] = 502 to "{}"
        assertNull(api.chapters("i1"))
    }

    @Test fun castInfo() {
        routes["GET /api/items/i1/castinfo"] = 200 to """{"item":{"id":"i1","name":"Pilot","type":"Episode","year":2020,"rating":"TV-14","communityRating":8.4},
            "cast":[{"id":"p1","name":"Ann","image":true,"role":"Hero"},{"id":"p2","name":"Bob","image":false}],
            "guests":[{"id":"p3","name":"Cy","image":true}],"directors":[{"id":"p4","name":"Di","image":false}],
            "writers":[],"creators":[{"id":"p5","name":"Ed","image":false}],"studios":["S1"],"genres":["Drama","Sci-Fi"],"tags":["x"]}"""
        val c = api.castInfo("i1")!!
        assertEquals("Pilot", c.name)
        assertEquals(2020, c.year)
        assertEquals("TV-14", c.rating)
        assertEquals(8.4, c.communityRating!!, 0.0)
        assertEquals(Person("p1", "Ann", "/media/Items/p1/Images/Primary?maxWidth=300&quality=85", "Hero"), c.cast[0])
        assertEquals(Person("p2", "Bob", null, null), c.cast[1])
        assertEquals(listOf("p3"), c.guests.map { it.id })
        assertEquals(listOf("p4"), c.directors.map { it.id })
        assertTrue(c.writers.isEmpty())
        assertEquals(listOf("p5"), c.creators.map { it.id })
        assertEquals(listOf("S1"), c.studios)
        assertEquals(listOf("Drama", "Sci-Fi"), c.genres)
    }

    @Test fun castInfoMissingFieldsAndFailure() {
        routes["GET /api/items/i1/castinfo"] = 200 to """{"item":{"id":"i1","name":"M","type":"Movie"}}"""
        val c = api.castInfo("i1")!!
        assertNull(c.year); assertNull(c.rating); assertNull(c.communityRating)
        assertTrue(c.cast.isEmpty() && c.genres.isEmpty())
        routes["GET /api/items/i1/castinfo"] = 404 to """{"error":"not_found"}"""
        assertNull(api.castInfo("i1"))
    }

    @Test fun personTitlesAndSimilar() {
        routes["GET /api/people/p1"] = 200 to """{"person":{"id":"p1","name":"Ann"},"items":[{"id":"m1","name":"Film","type":"Movie","year":1999,"image":true},{"id":"m2","name":"Show","type":"Series","image":false}]}"""
        assertEquals(
            listOf(Title("m1", "Film", "Movie", 1999, "/media/Items/m1/Images/Primary?maxWidth=300&quality=85"), Title("m2", "Show", "Series", null, null)),
            api.personTitles("p1"),
        )
        routes["GET /api/items/i1/similar"] = 200 to """{"items":[{"id":"m3","name":"Alike","type":"Movie","year":2001,"image":true}]}"""
        assertEquals(listOf("m3"), api.similar("i1")!!.map { it.id })
        assertEquals(emptyList<Title>(), api.personTitles("nobody")) // 404: nothing visible to this profile
        routes["GET /api/people/broken"] = 500 to """{"error":"x"}"""
        assertNull(api.personTitles("broken"))
        assertNull(api.personTitles("../x"))
        assertNull(api.similar("nobody"))
    }

    @Test fun bookmarks() {
        routes["GET /api/bookmarks"] = 200 to """{"bookmarks":[{"id":"b1","position":90,"note":"nice","created_at":"x"},{"id":"b2","position":5,"note":null}]}"""
        assertEquals(listOf(Bookmark("b1", 90, "nice"), Bookmark("b2", 5, null)), api.bookmarks("i1"))
        assertEquals("i1", last("GET", "/api/bookmarks").url.queryParameter("itemId"))
        routes["GET /api/bookmarks"] = 500 to "{}"
        assertNull(api.bookmarks("i1"))
    }

    @Test fun addAndRemoveBookmark() {
        routes["POST /api/bookmarks"] = 200 to """{"id":"b9"}"""
        assertEquals(ApiResult.Ok("b9"), api.addBookmark("i1", 42, "note"))
        val body = JSONObject(last("POST", "/api/bookmarks").body!!.utf8())
        assertEquals("i1", body.getString("itemId"))
        assertEquals(42, body.getInt("position"))
        assertEquals("note", body.getString("note"))
        assertEquals("tok", last("POST", "/api/bookmarks").headers["x-csrf-token"])
        api.addBookmark("i1", 1, null)
        assertFalse(JSONObject(last("POST", "/api/bookmarks").body!!.utf8()).has("note"))
        routes["DELETE /api/bookmarks/b9"] = 200 to """{"ok":true}"""
        assertTrue(api.removeBookmark("b9"))
        assertEquals("tok", last("DELETE", "/api/bookmarks/b9").headers["x-csrf-token"])
        assertFalse(api.removeBookmark("gone"))
    }

    @Test fun addBookmarkErrors() {
        routes["POST /api/bookmarks"] = 409 to """{"error":"too_many_bookmarks"}"""
        assertEquals(ApiResult.Err(409, "too_many_bookmarks"), api.addBookmark("i1", 1, null))
        routes["POST /api/bookmarks"] = 500 to "not json"
        assertEquals(ApiResult.Err(500, null), api.addBookmark("i1", 1, null))
    }

    @Test fun searchSubtitles() {
        routes["GET /api/items/i1/subtitles/search"] = 200 to """{"results":[{"id":"s1","name":"Movie.eng","provider":"OpenSubtitles","downloads":120,"rating":5},{"id":"s2","name":"Alt","provider":"X"}]}"""
        assertEquals(
            ApiResult.Ok(listOf(SubResult("s1", "Movie.eng", "OpenSubtitles", 120), SubResult("s2", "Alt", "X", 0))),
            api.searchSubtitles("i1", "eng"),
        )
        assertEquals("eng", last("GET", "/api/items/i1/subtitles/search").url.queryParameter("lang"))
    }

    @Test fun searchSubtitlesErrors() {
        routes["GET /api/items/i1/subtitles/search"] = 403 to """{"error":"forbidden"}"""
        assertEquals(ApiResult.Err(403, "forbidden"), api.searchSubtitles("i1", "eng"))
        routes["GET /api/items/i1/subtitles/search"] = 502 to """{"error":"subtitle_provider_unavailable"}"""
        assertEquals(ApiResult.Err(502, "subtitle_provider_unavailable"), api.searchSubtitles("i1", "eng"))
    }

    @Test fun downloadSubtitle() {
        routes["POST /api/items/i1/subtitles/download"] = 200 to """{"ok":true}"""
        assertEquals(ApiResult.Ok(Unit), api.downloadSubtitle("i1", "s1"))
        assertEquals("s1", JSONObject(last("POST", "/api/items/i1/subtitles/download").body!!.utf8()).getString("subtitleId"))
        routes["POST /api/items/i1/subtitles/download"] = 502 to """{"error":"subtitle_download_failed"}"""
        assertEquals(ApiResult.Err(502, "subtitle_download_failed"), api.downloadSubtitle("i1", "s1"))
    }

    @Test fun saveAudioFx() {
        routes["PUT /api/prefs/audiofx"] = 200 to """{"audioFx":"both"}"""
        assertTrue(api.saveAudioFx("both"))
        assertEquals("both", JSONObject(last("PUT", "/api/prefs/audiofx").body!!.utf8()).getString("audioFx"))
        routes["PUT /api/prefs/audiofx"] = 400 to "{}"
        assertFalse(api.saveAudioFx("both"))
    }

    @Test fun langPrefReadsAnimeFlag() {
        routes["GET /api/series/s1/langpref"] = 200 to """{"audio":"jpn","subtitle":"off","anime":true}"""
        assertEquals(LangPref("jpn", "off", true), api.langPref("s1", anime = true))
        assertEquals("1", last("GET", "/api/series/s1/langpref").url.queryParameter("anime"))
        routes["GET /api/series/s1/langpref"] = 200 to """{"audio":null,"subtitle":null}"""
        assertEquals(LangPref(null, null, false), api.langPref("s1"))
        assertNull(last("GET", "/api/series/s1/langpref").url.queryParameter("anime"))
        routes["GET /api/series/s1/langpref"] = 500 to "{}"
        assertEquals(LangPref(null, null, false), api.langPref("s1"))
    }

    @Test fun postplayStaysRawAndEventIsBestEffort() {
        routes["GET /api/items/i1/postplay"] = 200 to """{"state":"next","x":1}"""
        assertEquals(1, api.postplay("i1")!!.getInt("x"))
        routes["GET /api/items/i1/postplay"] = 404 to """{"error":"disabled"}"""
        assertNull(api.postplay("i1"))
        routes["POST /api/postplay/event"] = 204 to ""
        api.postplayEvent(JSONObject().put("type", "dismiss"))
        assertEquals("dismiss", JSONObject(last("POST", "/api/postplay/event").body!!.utf8()).getString("type"))
        routes["POST /api/postplay/event"] = 500 to ""
        api.postplayEvent(JSONObject().put("type", "dismiss")) // no throw
    }

    @Test fun sessionExpiredPropagates() {
        routes["GET /api/items/s1/seasons"] = 401 to "{}"
        try {
            api.seasons("s1")
            org.junit.Assert.fail("expected SessionExpired")
        } catch (_: SessionExpired) {
        }
    }
}
