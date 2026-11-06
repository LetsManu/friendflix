// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/** An unreadable download table must never turn every finished download into an "orphan". */
@RunWith(RobolectricTestRunner::class)
class CorruptStoreTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv

    @Before fun setUp() {
        File(tmp.root, "downloads.json").writeText("{ not json")
        env = TestEnv(tmp.root)
    }
    @After fun tearDown() { env.close() }

    @Test fun badTableIsKeptAsideAndNothingIsSwept() {
        assertTrue(env.store.loadFailed)
        assertTrue(env.store.all().isEmpty())
        assertEquals(1, tmp.root.listFiles()!!.count { it.name.startsWith("downloads.json.corrupt-") })
        val finished = env.complete()
        env.deps.queue.resumeAll()
        runBlocking { env.deps.queue.awaitScheduled() }
        assertTrue(finished.exists())
    }
}
