// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.media3.session.MediaSessionService
import androidx.media3.ui.PlayerView
import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
    private fun PlayerActivity.bar(id: Int) = findViewById<PlayerView>(R.id.player_view).findViewById<View>(id).visibility

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

    @Test fun aDownloadHasNoServerButtons() {
        val a = launch(intent("it1", "t1", license = "lic1"))
        for (id in listOf(R.id.player_episodes, R.id.player_scenes, R.id.player_info, R.id.player_cast, R.id.player_quality_chip, R.id.player_next_episode)) {
            assertEquals(a.resources.getResourceEntryName(id), View.GONE, a.bar(id))
        }
        a.findViewById<View>(R.id.player_more).performClick()
        assertNull(a.panelView(R.id.more_bookmarks))
        assertNull(a.panelView(R.id.more_quality))
        assertNull(a.panelView(R.id.more_cast))
        assertNotNull(a.panelView(R.id.more_speed))
        assertNotNull(a.panelView(R.id.more_sleep))
        assertNotNull(a.panelView(R.id.more_lock))
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
