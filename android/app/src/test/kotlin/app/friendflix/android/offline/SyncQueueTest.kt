// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import app.friendflix.android.downloads.ITEM
import app.friendflix.android.downloads.LIC
import app.friendflix.android.downloads.LIC2
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.TestEnv
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

private const val ITEM2 = "fedcba9876543210fedcba9876543210"

@RunWith(RobolectricTestRunner::class)
class SyncQueueTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private lateinit var file: File
    private lateinit var queue: SyncQueue
    private lateinit var api: ServerApi

    @Before fun setUp() {
        env = TestEnv(tmp.newFolder("env"))
        file = File(tmp.newFolder("state"), "sync-queue.json")
        queue = SyncQueue(file)
        api = runBlocking { env.deps.api()!! }
    }

    @After fun tearDown() { env.close() }

    private fun ev(at: Long, positionMs: Long, item: String = ITEM, lic: String = LIC, profile: String = PROFILE, played: Boolean = false) =
        SyncEvent(downloadId = lic, itemId = item, profileId = profile, positionTicks = positionMs * 10_000, played = played, at = at)

    private fun posts() = env.fake.api("/api/downloads/progress")
    private fun posted(i: Int = 0) = JSONObject(posts()[i].body!!.utf8()).getJSONArray("events")

    @Test fun twoQueuedPositionsPostTheNewestOnce() = runBlocking {
        queue.add(ev(at = 1_000, positionMs = 10_000))
        queue.add(ev(at = 2_000, positionMs = 20_000))
        queue.add(ev(at = 1_500, positionMs = 15_000)) // older than what is queued: ignored
        assertEquals(1, queue.pending().size)
        assertEquals(FlushResult.DONE, queue.flush(api, PROFILE))
        assertEquals(1, posts().size)
        val events = posted()
        assertEquals(1, events.length())
        val e = events.getJSONObject(0)
        assertEquals(200_000_000L, e.getLong("positionTicks"))
        assertEquals(2_000L, e.getLong("at"))
        assertEquals(LIC, e.getString("downloadId"))
        assertEquals(ITEM, e.getString("itemId"))
        assertEquals(PROFILE, posts()[0].headers["x-ff-profile"])
        assertEquals("tok", posts()[0].headers["x-csrf-token"])
        assertTrue(queue.pending().isEmpty())
        assertEquals(FlushResult.NOTHING, queue.flush(api, PROFILE))
        assertEquals("posted once", 1, posts().size)
    }

    @Test fun serverNewerWinsAndTheLocalStateIsNotPostedAgain() = runBlocking {
        env.fake.progressSkipped = setOf(ITEM)
        queue.add(ev(at = 5_000, positionMs = 42_000))
        assertEquals(FlushResult.DONE, queue.flush(api, PROFILE))
        assertEquals("sent with the time it was watched, so the server can compare", 5_000L, posted().getJSONObject(0).getLong("at"))
        assertTrue("server state is newer: the local position is dropped", queue.pending().isEmpty())
        assertEquals(FlushResult.NOTHING, queue.flush(api, PROFILE))
        assertEquals(1, posts().size)
    }

    @Test fun sessionExpiredStopsWithoutRetrying() = runBlocking {
        queue.add(ev(at = 1_000, positionMs = 10_000))
        queue.add(ev(at = 1_000, positionMs = 10_000, item = ITEM2, lic = LIC2))
        env.fake.unauthorized = true
        assertEquals(FlushResult.SIGNED_OUT, queue.flush(api, PROFILE))
        val calls = env.fake.requests.size
        assertTrue("one request at most (csrf), no retry storm", calls <= 2)
        assertEquals(2, queue.pending().size)
        env.fake.unauthorized = false
        assertEquals(FlushResult.DONE, queue.flush(api, PROFILE))
        assertTrue(queue.pending().isEmpty())
    }

    @Test fun serverTroubleKeepsTheEvents() = runBlocking {
        queue.add(ev(at = 1_000, positionMs = 10_000))
        env.fake.progressCode = 503
        assertEquals(FlushResult.LATER, queue.flush(api, PROFILE))
        env.fake.progressCode = 409 // another profile became active: try again later
        assertEquals(FlushResult.LATER, queue.flush(api, PROFILE))
        assertEquals(1, queue.pending().size)
    }

    @Test fun networkErrorKeepsTheEvents() = runBlocking {
        queue.add(ev(at = 1_000, positionMs = 10_000))
        env.server.close()
        assertEquals(FlushResult.LATER, queue.flush(api, PROFILE))
        assertEquals(1, queue.pending().size)
    }

    @Test fun rejectedEventsAreDropped() = runBlocking {
        queue.add(ev(at = 1_000, positionMs = 10_000))
        env.fake.progressCode = 400
        assertEquals(FlushResult.DONE, queue.flush(api, PROFILE))
        assertTrue(queue.pending().isEmpty())
    }

    @Test fun otherProfilesStayQueued() = runBlocking {
        queue.add(ev(at = 1_000, positionMs = 10_000))
        queue.add(ev(at = 1_000, positionMs = 30_000, profile = OTHER_PROFILE, item = ITEM2, lic = LIC2))
        queue.flush(api, PROFILE)
        assertEquals(1, posted().length())
        assertEquals(listOf(OTHER_PROFILE), queue.pending().map { it.profileId })
    }

    @Test fun anEventArrivingDuringTheFlushIsKept() = runBlocking {
        queue.add(ev(at = 1_000, positionMs = 10_000))
        env.fake.onProgress = { queue.add(ev(at = 9_000, positionMs = 90_000)) }
        queue.flush(api, PROFILE)
        assertEquals(listOf(9_000L), queue.pending().map { it.at })
    }

    @Test fun eventsSurviveARestartAndAreWrittenOffTheCallingThread() {
        val writers = mutableListOf<Thread>()
        val q = SyncQueue(file) { writers += Thread.currentThread() }
        q.add(ev(at = 1_000, positionMs = 10_000))
        q.add(ev(at = 2_000, positionMs = 10_000, item = ITEM2, lic = LIC2, played = true))
        q.flushToDisk()
        assertTrue(writers.isNotEmpty())
        assertTrue(writers.none { it == Thread.currentThread() })
        val again = SyncQueue(file)
        assertEquals(q.pending().toSet(), again.pending().toSet())
        assertTrue(again.pending().single { it.itemId == ITEM2 }.played)
        assertTrue(!File(file.path + ".tmp").exists())
    }

    @Test fun manyEventsGoInBatchesOf200() = runBlocking {
        repeat(250) { i -> queue.add(ev(at = 1_000, positionMs = 1_000, item = "%032x".format(i))) }
        queue.flush(api, PROFILE)
        assertEquals(2, posts().size)
        assertEquals(200, posted(0).length())
        assertEquals(50, posted(1).length())
        assertNotEquals(0, posts().size)
        assertTrue(queue.pending().isEmpty())
    }
}
