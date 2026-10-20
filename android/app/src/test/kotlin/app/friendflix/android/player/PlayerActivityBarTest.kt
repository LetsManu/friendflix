// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.session.MediaSessionService
import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowLooper

/**
 * The real player screen's wiring of [PlayerControls] (no server is set up, so a stream ends on the error box): picture-in-picture
 * reaches the controls, a new intent is a new title, and a download's bar follows the offline rule.
 */
@RunWith(RobolectricTestRunner::class)
class PlayerActivityBarTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private var ac: ActivityController<PlayerActivity>? = null

    @After fun tearDown() {
        ac?.let { if (!it.get().isFinishing) it.get().finish() }
        ShadowLooper.idleMainLooper()
    }

    private fun intent(item: String, token: String, license: String? = null) = Intent(context, PlayerActivity::class.java)
        .putExtra(PlayerActivity.EXTRA_ITEM, item)
        .putExtra(PlayerActivity.EXTRA_PROFILE, "p1")
        .putExtra(PlayerActivity.EXTRA_TOKEN, token)
        .apply { license?.let { putExtra(PlayerActivity.EXTRA_LICENSE, it) } }

    private fun launch(i: Intent): PlayerActivity {
        // no media session service in a unit test: the controller's bind is refused (the player itself plays on)
        shadowOf(context as Application).declareActionUnbindable(MediaSessionService.SERVICE_INTERFACE)
        val c = Robolectric.buildActivity(PlayerActivity::class.java, i).setup()
        ac = c
        ShadowLooper.idleMainLooper()
        return c.get()
    }

    private fun PlayerActivity.panelOpen() = (findViewById<ViewGroup>(R.id.player_panel_content)?.childCount ?: 0) > 0
    private fun PlayerActivity.panelView(id: Int): View? = findViewById<View>(R.id.player_panel_content)?.findViewById(id)

    @Test fun pictureInPictureClosesAnOpenPanel() {
        val a = launch(intent("it1", "t1"))
        a.findViewById<View>(R.id.player_more).performClick()
        assertTrue(a.panelOpen())
        a.onPictureInPictureModeChanged(true, Configuration())
        assertFalse(a.panelOpen())
    }

    @Test fun aNewIntentIsANewTitleForTheControls() {
        val a = launch(intent("it1", "t1"))
        a.findViewById<View>(R.id.player_more).performClick()
        a.panelView(R.id.more_speed)!!.performClick()
        ShadowLooper.idleMainLooper()
        clickText(a, "1.5×")
        val badge = a.findViewById<TextView>(R.id.player_more_badge)
        assertEquals(View.VISIBLE, badge.visibility)
        ac!!.newIntent(intent("it2", "t2"))
        ShadowLooper.idleMainLooper()
        assertEquals(View.GONE, badge.visibility) // speed back to 1 for the new title
    }

    /**
     * The activity's facts for the bar ([PlayerControls.Host.bar]) say "offline" exactly for a download (a licence id), from the
     * start on; [barState] then hides what needs the server (PlayerControlsTest covers the rule with a server and a title).
     */
    @Test fun aLicenceMakesTheBarOffline() {
        val online = barFacts(launch(intent("it1", "t1")))
        assertFalse(online.offline)
        ac!!.get().finish()
        val offline = barFacts(launch(intent("it1", "t2", license = "lic1")))
        assertTrue(offline.offline)
        // with everything a server and a title could offer, the download's facts still hide the server's buttons
        val s = barState(offline.copy(server = true, episode = true, chapters = true, extras = true, qualities = true, chip = true, subtitleSearch = true, hasNext = true, cast = CastUi(ready = true, enabled = true)))
        assertFalse(s.episodes || s.scenes || s.info || s.bookmarks || s.subtitleSearch || s.quality || s.chip || s.castButton || s.next)
        val o = barState(online.copy(server = true, episode = true, chapters = true, extras = true, qualities = true, chip = true, subtitleSearch = true, hasNext = true, cast = CastUi(ready = true, enabled = true)))
        assertTrue(o.episodes && o.scenes && o.info && o.bookmarks && o.subtitleSearch && o.quality && o.chip && o.castButton && o.next)
    }

    // ---- fullscreen: the system bars (Task 12) ----

    @Test fun systemBarsAreHiddenFromTheStart() {
        val a = launch(intent("it1", "t1"))
        assertFalse(a.systemBarsRequested())
        assertEquals(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE,
            WindowCompat.getInsetsController(a.window, a.window.decorView).systemBarsBehavior,
        )
    }

    @Test fun systemBarsAreHiddenAgainOnResume() {
        val a = launch(intent("it1", "t1"))
        a.showSystemBars() // e.g. back from another app or the notification shade
        ac!!.pause().stop().restart().start().resume()
        ShadowLooper.idleMainLooper()
        assertFalse(a.systemBarsRequested())
    }

    @Test fun systemBarsAreHiddenAgainWhenTheWindowRegainsFocus() {
        val a = launch(intent("it1", "t1"))
        a.showSystemBars()
        a.onWindowFocusChanged(false)
        assertTrue(a.systemBarsRequested()) // never shown or hidden by losing focus
        a.onWindowFocusChanged(true)
        assertFalse(a.systemBarsRequested())
    }

    @Test fun systemBarsAreHiddenAgainAfterPictureInPicture() {
        val a = launch(intent("it1", "t1"))
        a.onPictureInPictureModeChanged(true, Configuration())
        a.showSystemBars()
        a.onPictureInPictureModeChanged(false, Configuration())
        assertFalse(a.systemBarsRequested())
    }

    // ---- Chromecast without Google Play services ----

    /** a phone without Google Play services (as Robolectric): no Cast context, so no Chromecast button and no *Play on TV* */
    @Test fun noCastContextNoChromecastButton() {
        val a = launch(intent("it1", "t1"))
        assertEquals(View.GONE, a.findViewById<View>(R.id.player_cast).visibility)
        a.findViewById<View>(R.id.player_more).performClick()
        assertTrue(a.panelOpen())
        assertEquals(null, a.panelView(R.id.more_cast))
    }

    private fun barFacts(a: PlayerActivity): BarFacts {
        val f = PlayerActivity::class.java.getDeclaredField("controlsHost").apply { isAccessible = true }
        return (f.get(a) as PlayerControls.Host).bar()
    }

    private fun clickText(a: PlayerActivity, text: String) {
        fun find(v: View): TextView? = when {
            v is TextView && v.text.toString() == text -> v
            v is ViewGroup -> (0 until v.childCount).firstNotNullOfOrNull { find(v.getChildAt(it)) }
            else -> null
        }
        var c: View? = find(a.findViewById(R.id.player_panel_content))
        assertNotNull("no row $text", c)
        while (c != null && !c.isClickable) c = c.parent as? View
        c!!.performClick()
        ShadowLooper.idleMainLooper()
    }
}

/** shows the status and navigation bars as the system would (a swipe, a dialog, another app) */
internal fun Activity.showSystemBars() =
    WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())

/** the window asks for the status or navigation bar to be visible (Android 11+ insets controller's requested types) */
internal fun Activity.systemBarsRequested(): Boolean {
    val c = window.insetsController!!
    val types = c.javaClass.getMethod("getRequestedVisibleTypes").invoke(c) as Int
    return types and WindowInsets.Type.systemBars() != 0
}
