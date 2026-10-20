// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.friendflix.android.R
import app.friendflix.android.downloads.FakeCookies
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.player.panels.BookmarksPanel
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
class BookmarksPanelTest {
    private val server = MockWebServer()
    private val routes = ConcurrentHashMap<String, Pair<Int, String>>()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private lateinit var api: PlayerApi
    private lateinit var activity: ControlsTestActivity
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var position = 754_900L
    private val seeks = mutableListOf<Long>()
    private val shared = mutableListOf<String>()
    private val changed = mutableListOf<List<Bookmark>>()

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
        routes["GET /api/bookmarks"] = 200 to """{"bookmarks":[]}"""
        val cookies = FakeCookies().apply { jar[server.url("/").toString().trimEnd('/')] = "ff_sid=s3cret" }
        api = PlayerApi(ServerApi(server.url("/"), OkHttpClient(), cookies), PROFILE)
        activity = Robolectric.buildActivity(ControlsTestActivity::class.java).setup().get()
    }

    @After fun tearDown() { scope.cancel(); server.close() }

    private fun panel(): View = BookmarksPanel.build(activity, scope, api, "it1", { position }, { seeks += it }, { shared += it }) { changed += it }

    private fun await(done: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!done() && System.currentTimeMillis() < end) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("timed out", done())
    }

    private fun texts(v: View): List<String> =
        if (v is TextView) listOf(v.text.toString()) else if (v is ViewGroup) (0 until v.childCount).flatMap { texts(v.getChildAt(it)) } else emptyList()

    private fun list(v: View): ViewGroup = v.findViewById(R.id.bookmarks_list)
    private fun msg(v: View): TextView = v.findViewById(R.id.bookmarks_msg)
    private fun posts() = seen.filter { it.method == "POST" && it.url.encodedPath == "/api/bookmarks" }

    @Test fun addRefreshesTheListAndTheMarks() {
        val v = panel()
        await { changed.size == 1 }
        assertTrue(texts(v).contains(activity.getString(R.string.player_bookmark_none)))
        val note = v.findViewById<EditText>(R.id.bookmarks_note)
        note.setText("n".repeat(200))
        assertEquals(140, note.text.length) // max 140 like the web
        routes["POST /api/bookmarks"] = 200 to """{"id":"b1"}"""
        routes["GET /api/bookmarks"] = 200 to """{"bookmarks":[{"id":"b1","position":754,"note":"${"n".repeat(140)}"}]}"""
        v.findViewById<View>(R.id.bookmarks_add).performClick()
        await { list(v).childCount == 1 }
        val body = JSONObject(posts().single().body!!.utf8())
        assertEquals("it1", body.getString("itemId"))
        assertEquals(754, body.getInt("position"))
        assertEquals(140, body.getString("note").length)
        assertEquals("", note.text.toString())
        assertEquals(listOf(Bookmark("b1", 754, "n".repeat(140))), changed.last())
        assertEquals(activity.getString(R.string.player_bookmark_set), msg(v).text.toString())
        assertTrue(texts(list(v)).contains("12:34"))
    }

    @Test fun anEmptyNoteIsNotSent() {
        val v = panel()
        await { changed.size == 1 }
        routes["POST /api/bookmarks"] = 200 to """{"id":"b1"}"""
        v.findViewById<View>(R.id.bookmarks_add).performClick()
        await { posts().size == 1 && changed.size == 2 }
        assertTrue(!JSONObject(posts().single().body!!.utf8()).has("note"))
    }

    @Test fun bookmarksFailureShowsError() {
        val v = panel()
        await { changed.size == 1 }
        routes["POST /api/bookmarks"] = 409 to """{"error":"too_many_bookmarks"}"""
        v.findViewById<View>(R.id.bookmarks_add).performClick()
        await { msg(v).text.toString() == activity.getString(R.string.player_bookmark_too_many) }
        assertEquals(View.VISIBLE, msg(v).visibility)
        routes["POST /api/bookmarks"] = 500 to """{"error":"x"}"""
        v.findViewById<View>(R.id.bookmarks_add).performClick()
        await { msg(v).text.toString() == activity.getString(R.string.player_bookmark_failed) }
        assertEquals(1, changed.size) // nothing new to mark
    }

    @Test fun aTapSeeksAndRemoveDeletes() {
        routes["GET /api/bookmarks"] = 200 to """{"bookmarks":[{"id":"b1","position":60},{"id":"b2","position":3725,"note":"Fight"}]}"""
        val v = panel()
        await { list(v).childCount == 2 }
        assertTrue(texts(list(v).getChildAt(0)).contains(activity.getString(R.string.player_bookmark_title)))
        assertTrue(texts(list(v).getChildAt(1)).containsAll(listOf("1:02:05", "Fight")))
        list(v).getChildAt(1).performClick()
        assertEquals(listOf(3_725_000L), seeks)
        routes["DELETE /api/bookmarks/b1"] = 200 to """{"ok":true}"""
        routes["GET /api/bookmarks"] = 200 to """{"bookmarks":[{"id":"b2","position":3725,"note":"Fight"}]}"""
        list(v).getChildAt(0).findViewById<View>(R.id.bookmarks_remove).performClick()
        await { list(v).childCount == 1 }
        assertTrue(seen.any { it.method == "DELETE" && it.url.encodedPath == "/api/bookmarks/b1" })
        assertEquals(listOf(Bookmark("b2", 3725, "Fight")), changed.last())
    }

    @Test fun shareIntentTextEqualsShareUrl() {
        val v = panel()
        val row = v.findViewById<View>(R.id.bookmarks_share)
        assertTrue(texts(row).contains(activity.getString(R.string.player_bookmark_share, "12:34")))
        position = 800_000
        row.performClick()
        val origin = server.url("/").toString().trimEnd('/')
        assertEquals(listOf(shareUrl(origin, "it1", 800_000)), shared)
        val chooser = BookmarksPanel.shareIntent(shared.single())
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        @Suppress("DEPRECATION")
        val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/plain", send.type)
        assertEquals("$origin/watch/it1?t=800", send.getStringExtra(Intent.EXTRA_TEXT))
    }

    // ---- through the player bar's More panel ----

    @Test fun moreOffersBookmarksOnlineAndANewBookmarkTakesTheTvPosition() {
        val view = activity.findViewById<PlayerView>(R.id.player_view)
        val player = ExoPlayer.Builder(activity).build()
        try {
            view.player = player
            val host = ExtrasTestHost(player)
            val controls = PlayerControls(activity, view, player, host)
            controls.openMore()
            assertNull(activity.findViewById<View>(R.id.player_panel_content).findViewById(R.id.more_bookmarks)) // nothing to bookmark yet
            host.bookmarkSource = BookmarksSource(api, "it1")
            host.offline = true
            controls.openMore()
            assertNull(activity.findViewById<View>(R.id.player_panel_content).findViewById(R.id.more_bookmarks)) // hidden offline
            host.offline = false
            host.casting = true
            host.position = 99_500 // the TV's position
            controls.openMore()
            activity.findViewById<View>(R.id.player_panel_content).findViewById<View>(R.id.more_bookmarks).performClick()
            assertTrue(controls.panel.isOpen)
            val content = activity.findViewById<View>(R.id.player_panel_content)
            routes["POST /api/bookmarks"] = 200 to """{"id":"b1"}"""
            routes["GET /api/bookmarks"] = 200 to """{"bookmarks":[{"id":"b1","position":99}]}"""
            content.findViewById<View>(R.id.bookmarks_add).performClick()
            await { content.findViewById<ViewGroup>(R.id.bookmarks_list).childCount == 1 }
            assertEquals(99, JSONObject(posts().single().body!!.utf8()).getInt("position"))
            assertEquals(listOf(Bookmark("b1", 99, null)), controls.bookmarks) // the marks follow
            content.findViewById<ViewGroup>(R.id.bookmarks_list).getChildAt(0).performClick()
            assertEquals(listOf(99_000L), host.seeks) // seeks the TV
            assertTrue(!controls.panel.isOpen)
        } finally {
            player.release()
        }
    }
}
