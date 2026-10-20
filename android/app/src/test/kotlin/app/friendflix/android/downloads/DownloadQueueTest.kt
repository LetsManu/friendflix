// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import androidx.work.NetworkType
import androidx.work.WorkInfo
import app.friendflix.android.bridge.DownloadRequest
import app.friendflix.android.settings.StorageLocation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class DownloadQueueTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private val queue get() = env.deps.queue

    @Before fun setUp() { env = TestEnv(tmp.root) }
    @After fun tearDown() { env.close() }

    private fun works(id: String = LIC): List<WorkInfo> {
        runBlocking { queue.awaitScheduled() }
        return env.workManager.getWorkInfosForUniqueWork(DownloadQueue.workName(id)).get()
    }

    private fun req(id: String = LIC) = DownloadRequest(id, ITEM, PROFILE)

    @Test fun enqueueTwiceIsOneJob() {
        assertTrue(queue.enqueue(req()))
        assertTrue(queue.enqueue(req()))
        assertEquals(1, env.store.all().size)
        assertEquals(1, works().size)
        assertEquals(DownloadState.QUEUED, env.store.get(LIC)!!.state)
        assertEquals(DownloadFiles.video(LIC), env.store.get(LIC)!!.file)
    }

    @Test fun networkConstraintFollowsWifiOnly() {
        queue.enqueue(req())
        assertEquals(NetworkType.CONNECTED, works().single().constraints.requiredNetworkType)
        runBlocking { env.settings.setWifiOnly(true) }
        queue.enqueue(req(LIC2))
        assertEquals(NetworkType.UNMETERED, works(LIC2).single().constraints.requiredNetworkType)
    }

    // Review Focus 3: card pulled -> unavailable (nothing deleted); card back -> ready again.
    @Test fun unmountedCardMakesEntriesUnavailableAndBackReady() = runBlocking {
        val f = env.complete(kind = StorageLocation.SD)
        env.add(env.record(state = DownloadState.DONE, kind = StorageLocation.SD).copy(bytes = env.fake.content.size.toLong(), total = env.fake.content.size.toLong(), expiresAt = System.currentTimeMillis() + 86_400_000))
        assertEquals("done", queue.observe().first().single().state)
        env.volumes.sdMounted = false
        queue.refreshAvailability()
        assertEquals("unavailable", queue.observe().first().single().state)
        assertEquals("paused", queue.list().single().state) // the web UI's state names
        assertTrue(f.exists())
        assertTrue(env.store.get(LIC) != null)
        env.volumes.sdMounted = true
        queue.refreshAvailability()
        assertEquals("done", queue.observe().first().single().state)
        assertEquals(1.0, queue.list().single().progress, 0.0)
        assertArrayEquals(env.fake.content, env.plaintext(f))
    }

    @Test fun deleteRemovesFilesRecordAndTellsTheServer() {
        val f = env.complete()
        val sub = File(f.parentFile, DownloadFiles.subtitle(LIC, 0, "vtt")).apply { writeText("x") }
        env.add(env.record(state = DownloadState.DONE).copy(subtitles = listOf(SubtitleFile("de", sub.name))))
        assertTrue(queue.delete(LIC))
        assertNull(env.store.get(LIC)) // the bridge's answer only needs the in-memory row; files go off the UI thread
        runBlocking { queue.awaitScheduled() }
        assertFalse(f.exists())
        assertFalse(sub.exists())
        assertEquals(1, env.workManager.getWorkInfosForUniqueWork(DownloadQueue.deleteName(LIC)).get().size)
        assertFalse(queue.delete(LIC))
    }

    @Test fun listShape() {
        env.add(env.record().copy(bytes = 250, total = 1000, expiresAt = 42))
        val e = queue.list().single()
        assertEquals(LIC, e.licenseId)
        assertEquals(ITEM, e.itemId)
        assertEquals("queued", e.state)
        assertEquals(0.25, e.progress, 0.0)
        assertEquals(250, e.bytes)
    }

    @Test fun enqueueAfterSessionExpiryResumesPausedDownloads() {
        env.add(env.record(state = DownloadState.SIGNED_OUT))
        queue.enqueue(req(LIC2))
        assertEquals(DownloadState.QUEUED, env.store.get(LIC)!!.state)
        assertEquals(1, works(LIC).size)
    }

    @Test fun resumeAllRequeuesUnfinishedAndSweepsOrphans() {
        env.add(env.record(state = DownloadState.SIGNED_OUT))
        env.add(env.record(id = LIC2, state = DownloadState.DONE))
        val orphan = File(File(env.volumes.phone, "downloads").apply { mkdirs() }, DownloadFiles.video("9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d")).apply { writeText("x") }
        val kept = env.complete(LIC2)
        queue.resumeAll()
        runBlocking { queue.awaitScheduled() }
        assertEquals(DownloadState.QUEUED, env.store.get(LIC)!!.state)
        assertEquals(1, works(LIC).size)
        assertTrue(works(LIC2).isEmpty())
        assertFalse(orphan.exists())
        assertTrue(kept.exists())
    }

    @Test fun redownloadDeletesAndRequeues() {
        val f = env.complete()
        env.add(env.record(state = DownloadState.DONE, etag = env.fake.etag))
        queue.redownload(LIC)
        runBlocking { queue.awaitScheduled() }
        assertFalse(f.exists())
        assertEquals(DownloadState.QUEUED, env.store.get(LIC)!!.state)
        assertNull(env.store.get(LIC)!!.etag)
        assertEquals(1, works().size)
    }
}
