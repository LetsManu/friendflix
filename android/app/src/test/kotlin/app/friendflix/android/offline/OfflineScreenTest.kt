// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import app.friendflix.android.R
import app.friendflix.android.crypto.KeysUnavailableException
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.downloads.KeySource
import app.friendflix.android.downloads.LIC
import app.friendflix.android.downloads.LIC2
import app.friendflix.android.downloads.TestEnv
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
class OfflineScreenTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private lateinit var offline: Offline
    private val launcher = FakeLauncher()
    private val now = System.currentTimeMillis()

    @Before fun setUp() {
        env = TestEnv(tmp.newFolder("env"))
        offline = Offline(env.deps, tmp.newFolder("state")) { now }
        offline.launcher = launcher
        Offline.install(offline)
        env.complete(LIC)
        env.add(env.record(LIC, DownloadState.DONE).copy(title = "Alpha", total = 1000, expiresAt = now + 3 * DAY, lastCheck = now - DAY, validUntil = now + 6 * DAY, positionMs = 5_000))
        env.complete(LIC2)
        env.add(env.record(LIC2, DownloadState.DONE).copy(title = "Beta", total = 1000, expiresAt = now + 3 * DAY, lastCheck = now - 8 * DAY, validUntil = now - DAY))
    }

    @After fun tearDown() {
        Offline.install(null)
        env.close()
    }

    private fun <T> withScreen(block: (OfflineActivity) -> T): T {
        ActivityScenario.launch(OfflineActivity::class.java).use { s ->
            ShadowLooper.idleMainLooper()
            var out: T? = null
            s.onActivity { out = block(it) }
            return out!!
        }
    }

    private fun rows(a: OfflineActivity): List<View> = a.findViewById<LinearLayout>(R.id.offline_list).let { l -> (0 until l.childCount).map { l.getChildAt(it) } }

    @Test fun listsTheDownloadsWithReasonsAndPlaysTheLocalFile() = withScreen { a ->
        val rows = rows(a)
        assertEquals(listOf(LIC, LIC2), rows.map { it.tag })
        assertEquals("Alpha", rows[0].findViewById<TextView>(R.id.offline_item_title).text.toString())
        assertTrue(rows[0].findViewById<TextView>(R.id.offline_item_meta).text.contains("3 days left"))
        val blocked = rows[1].findViewById<TextView>(R.id.offline_item_reason)
        assertEquals(View.VISIBLE, blocked.visibility)
        assertEquals(a.getString(R.string.offline_reason_checkin), blocked.text.toString())
        assertFalse(rows[1].findViewById<Button>(R.id.offline_item_play).isEnabled)
        rows[0].findViewById<Button>(R.id.offline_item_play).performClick()
        // play opens the keys first (off the main thread) when the screen's own open has not finished yet
        val until = System.currentTimeMillis() + 5_000
        while (launcher.requests.isEmpty() && System.currentTimeMillis() < until) { ShadowLooper.idleMainLooper(); Thread.sleep(10) }
        val req = launcher.requests.single()
        assertEquals(LIC, req.offline!!.licenseId)
        assertEquals(5_000L, req.startMs)
    }

    @Test fun keysUnavailableShowsTheNoticeAndKeepsTheList() {
        env.keySource = KeySource { throw KeysUnavailableException("busy") }
        runBlocking { offline.checker.openKeys() }
        withScreen { a ->
            assertEquals(a.getString(R.string.offline_keys_unavailable), a.findViewById<TextView>(R.id.offline_status).text.toString())
            assertEquals(2, rows(a).size)
            assertTrue(rows(a).none { it.findViewById<Button>(R.id.offline_item_play).isEnabled })
        }
    }

    @Test fun emptyListSaysSo() {
        env.deps.queue.delete(LIC)
        env.deps.queue.delete(LIC2)
        withScreen { a ->
            assertEquals(a.getString(R.string.offline_none), a.findViewById<TextView>(R.id.offline_status).text.toString())
            assertTrue(rows(a).isEmpty())
        }
    }
}
