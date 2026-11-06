// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class PlayerResetTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test fun aResetClosesTheScreensAndReleasesThePlayerAndSession() {
        val open = PendingIntent.getActivity(context, 0, Intent(context, PlayerActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        PlayerHolder.acquire(context, open)
        assertNotNull(PlayerHolder.player)
        val closed = AtomicInteger()
        val reported = AtomicInteger()
        // a screen's close sends its stop report on the report thread; the reset waits for it
        val screen: () -> Unit = { closed.incrementAndGet(); Players.reports.execute { Thread.sleep(200); reported.incrementAndGet() } }
        PlayerReset.listen(screen)
        val before = PlayerReset.epoch.value
        val t = Thread { runBlocking { PlayerReset.stopAll(context) } }.apply { start() }
        val until = System.currentTimeMillis() + 10_000
        while (t.isAlive && System.currentTimeMillis() < until) { ShadowLooper.idleMainLooper(); Thread.sleep(5) }
        assertFalse(t.isAlive)
        PlayerReset.unlisten(screen)
        assertEquals(1, closed.get())
        assertEquals(1, reported.get()) // the stop report left before stopAll returned (the cookie is cleared after it)
        assertEquals(before + 1, PlayerReset.epoch.value)
        assertNull(PlayerHolder.player)
        assertNull(PlayerHolder.session)
    }
}
