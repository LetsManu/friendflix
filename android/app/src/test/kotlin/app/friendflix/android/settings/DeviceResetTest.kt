// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.settings

import android.webkit.CookieManager
import androidx.work.WorkInfo
import app.friendflix.android.crypto.KeyProvider
import app.friendflix.android.crypto.TestKeys
import app.friendflix.android.downloads.DownloadQueue
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.downloads.Downloads
import app.friendflix.android.downloads.ITEM
import app.friendflix.android.downloads.LIC
import app.friendflix.android.downloads.LIC2
import app.friendflix.android.downloads.OpenOnceKeySource
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.TestEnv
import app.friendflix.android.notify.NotificationPoller
import app.friendflix.android.notify.NotificationScheduler
import app.friendflix.android.offline.Offline
import app.friendflix.android.offline.SyncEvent
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLooper
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class DeviceResetTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private lateinit var offline: Offline
    private lateinit var keySource: OpenOnceKeySource<KeyProvider>
    private val webCleared = AtomicInteger()
    private val keysWiped = AtomicInteger()
    private lateinit var originKey: String

    @Before fun setUp() {
        env = TestEnv(tmp.newFolder("env"))
        keySource = OpenOnceKeySource({ TestKeys() }, { false }, {})
        keySource.keys() // open, as a running app has them
        // the app's wiring: the download graph holds the key source itself (TestEnv wraps its own in a lambda)
        val deps = Downloads(env.context, env.store, env.locations, env.settings, keySource, env.workManager, OkHttpClient(), env.cookies, env.notifier, env.scope)
        Downloads.install(deps)
        offline = Offline(deps, tmp.newFolder("state"))
        // a finished download on the phone, a partial one on the card, and an orphan file
        env.complete(LIC)
        env.add(env.record(LIC, DownloadState.DONE).copy(title = "Alpha"))
        env.partial(1000, LIC2, app.friendflix.android.settings.StorageLocation.SD)
        env.add(env.record(LIC2, DownloadState.DOWNLOADING, kind = StorageLocation.SD))
        File(env.video(LIC).parentFile, "leftover.ffv.part").writeText("x")
        deps.queue.resumeAll()
        runBlocking { deps.queue.awaitScheduled() }
        offline.noteProfile(PROFILE)
        offline.state.checkedAt(System.currentTimeMillis())
        offline.sync.add(SyncEvent(LIC, ITEM, PROFILE, 1234, false, 1))
        originKey = NotificationPoller.originKey(env.server.url("/"))
        runBlocking {
            env.settings.setNotifyLastId(originKey, 42)
            env.settings.setNotifyCategories(setOf("new"))
            env.settings.setCastConfig(true, "ABCD1234")
        }
    }

    @After fun tearDown() { env.close() }

    private fun reset() = DeviceReset(env.context, offline, web = { webCleared.incrementAndGet() }, wipeKeys = { keysWiped.incrementAndGet() })

    private fun downloadFiles(): List<String> =
        listOf(env.dir(StorageLocation.PHONE), env.dir(StorageLocation.SD)).flatMap { File(it, "downloads").listFiles().orEmpty().map(File::getName) }

    private fun assertLocalStateGone() {
        assertTrue(env.store.all().isEmpty())
        assertEquals(emptyList<String>(), downloadFiles())
        assertTrue(offline.sync.pending().isEmpty())
        assertNull(offline.state.lastProfileId)
        assertEquals(0L, offline.state.lastCheck)
        assertEquals(1, webCleared.get())
        // reloaded from disk too
        assertTrue(app.friendflix.android.downloads.DownloadStore(File(tmp.root, "env/downloads.json")).all().isEmpty())
        val downloadsWork = env.workManager.getWorkInfosByTag(DownloadQueue.TAG).get()
        assertTrue(downloadsWork.isNotEmpty() && downloadsWork.all { it.state == WorkInfo.State.CANCELLED })
        // the poll is planned again (it does nothing until someone signs in)
        val poll = env.workManager.getWorkInfosForUniqueWork(NotificationScheduler.WORK_NAME).get()
        assertTrue(poll.any { it.state == WorkInfo.State.ENQUEUED })
        runBlocking { assertNull(env.settings.notifyLastId(originKey).first()) }
    }

    @Test fun signOutWipesCookiesKeysAndDownloadsAndEndsTheSession() = runBlocking {
        reset().signOut()
        assertLocalStateGone()
        assertEquals(1, keysWiped.get())
        assertNull(keySource.current()) // the next download opens (creates) fresh keys
        assertNotNull(env.settings.serverOrigin.first()) // same server, now on its sign-in page
        assertEquals(setOf("new"), env.settings.notifyCategoriesChosen.first()) // choices stay
        // licences given back to the server, then the session ended there, while the cookie still existed
        val deletes = env.fake.requests.filter { it.method == "DELETE" }.map { it.url.encodedPath }.toSet()
        assertEquals(setOf("/api/downloads/$LIC", "/api/downloads/$LIC2"), deletes)
        val last = env.fake.requests.last()
        assertEquals("/auth/logout", last.url.encodedPath)
        assertEquals("tok", last.headers["x-csrf-token"])
        assertEquals("ff_sid=s3cret", last.headers["cookie"])
    }

    @Test fun anExpiredRowIsNotGivenBack() = runBlocking {
        env.store.update(LIC2) { it.copy(state = DownloadState.EXPIRED) }
        reset().signOut()
        assertEquals(listOf("/api/downloads/$LIC"), env.fake.requests.filter { it.method == "DELETE" }.map { it.url.encodedPath })
    }

    @Test fun serverChangeWithTheOldServerUnreachableClearsLocallyAndKeepsTheKeys() = runBlocking {
        env.server.close()
        reset().leaveServer()
        assertLocalStateGone()
        assertEquals(0, keysWiped.get())
        assertNotNull(keySource.current()) // keys belong to the device
        assertNull(env.settings.serverOrigin.first()) // setup runs for the new address
        assertFalse(env.settings.castEnabled.first())
        assertEquals("", env.settings.castReceiverAppId.first())
        assertEquals(setOf("new"), env.settings.notifyCategoriesChosen.first())
    }

    @Test fun serverChangeGivesTheLicencesBackToTheOldServerWhenReachable() = runBlocking {
        reset().leaveServer()
        assertEquals(2, env.fake.requests.count { it.method == "DELETE" })
        assertEquals("/auth/logout", env.fake.requests.last().url.encodedPath)
    }

    @Test fun aSignedOutSessionStillClearsEverything() = runBlocking {
        env.fake.unauthorized = true
        reset().signOut()
        assertLocalStateGone()
        assertEquals(0, env.fake.requests.count { it.method == "DELETE" })
    }

    @Test fun theRealWebSessionRemovesTheCookies() {
        val cm = CookieManager.getInstance()
        cm.setCookie("https://friend.example.com", "ff_sid=s3cret; Secure; HttpOnly")
        assertNotNull(cm.getCookie("https://friend.example.com"))
        val done = Thread { runBlocking { SystemWebSession.clear() } }.apply { start() }
        val until = System.currentTimeMillis() + 5_000
        while (done.isAlive && System.currentTimeMillis() < until) { ShadowLooper.idleMainLooper(); Thread.sleep(5) }
        assertFalse(done.isAlive)
        assertNull(cm.getCookie("https://friend.example.com"))
    }
}
