// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.friendflix.android.R
import app.friendflix.android.player.panels.EpisodesSource
import app.friendflix.android.player.panels.ScenesPanel
import app.friendflix.android.player.panels.TracksActions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** The player's side for the scenes / bookmarks tests: [active] records seeks and reports [position] (the TV's while casting). */
internal class ExtrasTestHost(local: Player) : PlayerControls.Host {
    val seeks = mutableListOf<Long>()
    var position = 0L
    var casting = false
    var offline = false
    var bookmarkSource: BookmarksSource? = null
    var imageLoader: ImageLoader? = null
    private val tv = object : ForwardingPlayer(local) {
        override fun seekTo(positionMs: Long) { seeks += positionMs }
        override fun getCurrentPosition(): Long = position
    }
    override fun active(): Player = tv
    override fun casting() = casting
    override fun offline() = offline
    override fun inPip() = false
    override fun flash(text: String, ms: Long) {}
    override fun pipSupported() = true
    override fun enterPip() {}
    override fun pauseActive() {}
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
    override fun episodes(): EpisodesSource? = null
    override fun playItem(id: String) {}
    override fun images(): ImageLoader? = imageLoader
    override fun bookmarks(): BookmarksSource? = bookmarkSource
}

@RunWith(RobolectricTestRunner::class)
class ScenesPanelTest {
    private lateinit var activity: ControlsTestActivity
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val chapters = listOf(Chapter(0.0, "Opening", null), Chapter(125.5, "", null), Chapter(300.0, "Finale", null))

    @Before fun setUp() {
        activity = Robolectric.buildActivity(ControlsTestActivity::class.java).setup().get()
    }

    @After fun tearDown() { scope.cancel() }

    private fun texts(v: View): List<String> =
        if (v is TextView) listOf(v.text.toString()) else if (v is ViewGroup) (0 until v.childCount).flatMap { texts(v.getChildAt(it)) } else emptyList()

    @Test fun scenesTapSeeksToChapterStart() {
        val seeks = mutableListOf<Double>()
        val v = ScenesPanel.build(activity, scope, null, chapters, currentSec = 130.0) { seeks += it }
        val list = v.findViewById<ViewGroup>(R.id.scenes_list)
        assertEquals(3, list.childCount)
        assertTrue(texts(v).contains(activity.resources.getQuantityString(R.plurals.player_scenes_count, 3, 3)))
        // an unnamed chapter gets "Chapter 2"; the playing one is marked
        val second = list.getChildAt(1)
        assertTrue(texts(second).contains(activity.getString(R.string.player_scenes_chapter, 2)))
        assertTrue(texts(second).contains(activity.getString(R.string.player_scenes_current)))
        assertTrue(second.isSelected)
        assertTrue(texts(second).contains("2:05"))
        assertFalse(list.getChildAt(0).isSelected)
        assertEquals(activity.getString(R.string.player_scenes_jump, "Finale", "5:00"), list.getChildAt(2).contentDescription)
        list.getChildAt(2).performClick()
        assertEquals(listOf(300.0), seeks)
    }

    @Test fun chapterIndexAtIsTheLastStarted() {
        assertEquals(-1, chapterIndexAt(listOf(Chapter(10.0, "a", null)), 5.0))
        assertEquals(0, chapterIndexAt(chapters, 0.0))
        assertEquals(1, chapterIndexAt(chapters, 125.46)) // 0.05 s tolerance like the web
        assertEquals(2, chapterIndexAt(chapters, 999.0))
    }

    @Test fun marksAreChapterStartsAfterZeroAndBookmarks() {
        val marks = seekMarksMs(chapters, listOf(Bookmark("b1", 200, null), Bookmark("b2", 300, "x")))
        assertArrayEquals(longArrayOf(125_500, 200_000, 300_000), marks)
        assertArrayEquals(longArrayOf(), seekMarksMs(emptyList(), emptyList()))
    }

    // ---- through the player bar ----

    private fun withControls(block: (PlayerControls, ExtrasTestHost, PlayerView) -> Unit) {
        val view = activity.findViewById<PlayerView>(R.id.player_view)
        val player = ExoPlayer.Builder(activity).build()
        try {
            view.player = player
            val host = ExtrasTestHost(player)
            block(PlayerControls(activity, view, player, host), host, view)
        } finally {
            player.release()
        }
    }

    @Test fun scenesButtonHiddenWithEmptyChapters() = withControls { controls, host, view ->
        val button = view.findViewById<View>(R.id.player_scenes)
        assertEquals(View.GONE, button.visibility)
        controls.setChapters(emptyList())
        assertEquals(View.GONE, button.visibility)
        controls.setChapters(chapters)
        assertEquals(View.VISIBLE, button.visibility)
        // a new title: chapters, bookmarks and their marks go until the new title's are loaded
        controls.setBookmarks(listOf(Bookmark("b", 42, null)))
        assertArrayEquals(longArrayOf(42_000, 125_500, 300_000), controls.marksMs)
        controls.newTitle()
        assertEquals(View.GONE, button.visibility)
        assertArrayEquals(longArrayOf(), controls.marksMs)
        assertTrue(controls.chapters.isEmpty())
        assertTrue(controls.bookmarks.isEmpty())
        // offline: no scenes from the server
        host.offline = true
        controls.setChapters(chapters)
        assertEquals(View.GONE, button.visibility)
    }

    @Test fun scenesButtonOpensThePanelAndATapSeeksTheActivePlayer() = withControls { controls, host, view ->
        host.casting = true // while casting the active player is the TV's
        host.position = 130_000
        controls.setChapters(chapters)
        view.findViewById<View>(R.id.player_scenes).performClick()
        assertTrue(controls.panel.isOpen)
        val list = activity.findViewById<View>(R.id.player_panel_content).findViewById<ViewGroup>(R.id.scenes_list)
        assertTrue(list.getChildAt(1).isSelected)
        list.getChildAt(2).performClick()
        assertEquals(listOf(300_000L), host.seeks)
        assertFalse(controls.panel.isOpen)
    }
}
