// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import app.friendflix.android.crypto.KeysUnavailableException
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.downloads.KeySource
import app.friendflix.android.downloads.LIC
import app.friendflix.android.downloads.TestEnv
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Task 8 contract of the offline gate: the player only plays an [OfflineMedia] that [Offline.prepare] handed out (through
 * [Offline.play] or, when the player is restored, a fresh [Offline.prepare]); keys that are not open yet are opened before the verdict.
 */
@RunWith(RobolectricTestRunner::class)
class OfflinePlayGateTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private lateinit var offline: Offline
    private var clock = 1_800_000_000_000L
    private val launcher = FakeLauncher()

    @Before fun setUp() {
        env = TestEnv(tmp.newFolder("env"))
        offline = Offline(env.deps, tmp.newFolder("state")) { clock }
        offline.launcher = launcher
        env.complete(LIC)
        env.add(
            env.record(LIC, DownloadState.DONE).copy(
                bytes = env.fake.content.size.toLong(), total = env.fake.content.size.toLong(),
                expiresAt = clock + 30 * DAY, lastCheck = clock - DAY, validUntil = clock + 6 * DAY, positionMs = 42_000,
            ),
        )
    }

    @After fun tearDown() { env.close() }

    @Test fun keysNotOpenYetAreOpenedBeforeTheVerdictNotPassed() = runBlocking {
        env.keySource = KeySource { throw KeysUnavailableException("keystore busy") }
        assertNull("nothing opened the keys yet", offline.checker.keysAvailable.value)
        assertEquals(PlayResult.Blocked(PlayBlock.KEYS_UNAVAILABLE), offline.play(LIC))
        assertTrue("nothing is launched", launcher.requests.isEmpty())
    }

    @Test fun keysNotOpenYetAreOpenedThenItPlays() = runBlocking {
        assertNull(offline.checker.keysAvailable.value)
        assertEquals(PlayResult.Started, offline.play(LIC))
        assertEquals(true, offline.checker.keysAvailable.value)
        assertEquals(LIC, launcher.requests.single().offline!!.licenseId)
    }

    @Test fun restoreRerunsTheVerdict() = runBlocking {
        assertEquals(PlayResult.Started, offline.play(LIC))
        // the player is recreated (process death / rotation) 8 days later: the offline window is over
        clock += 8 * DAY
        val again = offline.prepare(LIC)
        assertEquals(Prepared.Blocked(PlayBlock.CHECK_IN), again)
    }

    @Test fun restoreWithinTheWindowGivesAFreshMediaAtTheSavedPosition() = runBlocking {
        offline.play(LIC)
        offline.recordPosition(LIC, 90_000, played = false)
        val again = offline.prepare(LIC) as Prepared.Ready
        assertEquals(LIC, again.request.offline!!.licenseId)
        assertEquals(90_000L, again.request.startMs)
    }

    @Test fun restoreOfARevokedDownloadIsRefused() = runBlocking {
        offline.play(LIC)
        env.deps.queue.revoke(LIC)
        assertEquals(Prepared.Blocked(PlayBlock.EXPIRED), offline.prepare(LIC))
    }
}
