// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

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
class StorageTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv

    @Before fun setUp() { env = TestEnv(tmp.root) }
    @After fun tearDown() { env.close() }

    @Test fun availableListsBothVolumesWithMountedState() {
        val all = env.locations.available()
        assertEquals(listOf(StorageLocation.PHONE, StorageLocation.SD), all.map { it.kind })
        assertTrue(all.all { it.mounted && it.freeBytes > 0 })
        env.volumes.sdMounted = false
        val sd = env.locations.available().single { it.kind == StorageLocation.SD }
        assertFalse(sd.mounted)
        assertEquals(0, sd.freeBytes)
        assertNull(env.locations.dirIfMounted(StorageLocation.SD))
        env.volumes.sdPresent = false
        assertEquals(listOf(StorageLocation.PHONE), env.locations.available().map { it.kind })
    }

    @Test fun storeSurvivesReload() {
        env.add(env.record(state = DownloadState.DONE, etag = "\"e\"").copy(title = TITLE, subtitles = listOf(SubtitleFile("de", "x.vtt")), bytes = 5, total = 9, expiresAt = 7, lastCheck = 8))
        assertFalse(env.store.insertIfAbsent(env.record()))
        env.store.flush()
        val again = DownloadStore(File(tmp.root, "downloads.json"))
        assertEquals(env.store.get(LIC), again.get(LIC))
        assertEquals(DownloadState.DONE, again.get(LIC)!!.state)
    }

    @Test fun writesAreAsyncButOrdered() {
        repeat(50) { i -> env.store.update(LIC) { it.copy(bytes = i.toLong()) } ?: env.add(env.record().copy(bytes = i.toLong())) }
        env.store.flush()
        assertEquals(49L, DownloadStore(File(tmp.root, "downloads.json")).get(LIC)!!.bytes)
    }

    @Test fun storeWritesStayOffTheCallingThread() {
        val calling = Thread.currentThread()
        val seen = java.util.concurrent.atomic.AtomicReference<Thread>()
        val store = DownloadStore(File(tmp.root, "other.json")) { seen.set(Thread.currentThread()) }
        store.insertIfAbsent(env.record())
        store.flush()
        assertTrue(seen.get() != null && seen.get() != calling)
    }

    @Test fun moveCopiesVerifiesThenDeletesTheSource() = runBlocking {
        val f = env.complete()
        val poster = File(f.parentFile, DownloadFiles.poster(LIC)).also { app.friendflix.android.crypto.EncryptedWriter(it, env.keys).use { w -> w.append(byteArrayOf(1, 2, 3)); w.finish() } }
        env.add(env.record(state = DownloadState.DONE).copy(bytes = env.fake.content.size.toLong()))
        assertTrue(StorageMover(env.deps).moveAll(StorageLocation.SD))
        assertEquals(StorageLocation.SD, env.store.get(LIC)!!.location)
        assertFalse(f.exists())
        assertFalse(poster.exists())
        val moved = File(File(env.volumes.sd, "downloads"), DownloadFiles.video(LIC))
        assertArrayEquals(env.fake.content, env.plaintext(moved))
        assertTrue(File(moved.parentFile, DownloadFiles.poster(LIC)).exists())
        assertTrue(moved.parentFile!!.listFiles()!!.none { it.name.endsWith(".part") })
    }

    @Test fun moveToAnUnmountedCardChangesNothing() = runBlocking {
        val f = env.complete()
        env.add(env.record(state = DownloadState.DONE))
        env.volumes.sdMounted = false
        assertFalse(StorageMover(env.deps).moveAll(StorageLocation.SD))
        assertTrue(f.exists())
        assertEquals(StorageLocation.PHONE, env.store.get(LIC)!!.location)
    }

    @Test fun moveSetsThePreferenceAndSchedulesTheWorker() = runBlocking {
        env.locations.move(StorageLocation.SD)
        assertEquals(StorageLocation.SD, env.settings.storage.first())
        assertEquals(1, env.workManager.getWorkInfosForUniqueWork(StorageMoveWorker.NAME).get().size)
    }

    @Test fun moveSkipsADownloadInProgress() = runBlocking {
        val f = env.partial(1 shl 20)
        env.add(env.record(state = DownloadState.DOWNLOADING))
        assertTrue(StorageMover(env.deps).moveAll(StorageLocation.SD))
        assertTrue(f.exists())
        assertEquals(StorageLocation.PHONE, env.store.get(LIC)!!.location)
    }
}
