// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SleepTimerTest {
    private var now = 1_000L
    private val timer = SleepTimer { now }

    @Test fun dueOnceAfterTheMinutes() {
        timer.set(15)
        assertEquals(15 * 60_000L, timer.remainingMs())
        now += 15 * 60_000L - 1
        assertFalse(timer.due())
        assertEquals(1L, timer.remainingMs())
        now += 1
        assertTrue(timer.due())
        assertFalse(timer.due())
        assertNull(timer.remainingMs())
    }

    @Test fun offClears() {
        timer.set(5)
        timer.off()
        now += 10 * 60_000L
        assertFalse(timer.due())
        assertNull(timer.remainingMs())
    }

    @Test fun afterEpisodeHasNoRemaining() {
        timer.set(5)
        timer.setAfterEpisode()
        assertTrue(timer.afterEpisode)
        assertNull(timer.remainingMs())
        now += 10 * 60_000L
        assertFalse(timer.due())
    }

    @Test fun settingMinutesClearsAfterEpisode() {
        timer.setAfterEpisode()
        timer.set(5)
        assertFalse(timer.afterEpisode)
    }

    @Test fun offClearsAfterEpisode() {
        timer.setAfterEpisode()
        timer.off()
        assertFalse(timer.afterEpisode)
    }
}
