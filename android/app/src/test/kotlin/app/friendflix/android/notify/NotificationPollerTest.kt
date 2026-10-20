// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.notify

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.testing.TestListenableWorkerBuilder
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.TestEnv
import app.friendflix.android.shell.ShellActivity
import app.friendflix.android.shell.ShellIntents
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
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
import org.robolectric.Shadows.shadowOf
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList

private class FakePoster : NotePoster {
    @Volatile var allowed = true
    val posted = CopyOnWriteArrayList<Triple<ServerNote, NotifyCategory, String?>>()
    override fun canPost() = allowed
    override fun post(note: ServerNote, category: NotifyCategory, path: String?) { posted += Triple(note, category, path) }
}

@RunWith(RobolectricTestRunner::class)
class NotificationPollerTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private val poster = FakePoster()
    private var notes = JSONArray()
    private var code = 200
    private var meCode = 200
    private var drop = false
    private val seen = CopyOnWriteArrayList<RecordedRequest>()

    @Before fun setUp() {
        env = TestEnv(tmp.root)
        env.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                if (drop) return MockResponse.Builder().onRequestStart(mockwebserver3.SocketEffect.CloseSocket()).build()
                return when (request.url.encodedPath) {
                    "/api/me" -> json(meCode, JSONObject().put("csrfToken", "t").put("profile", JSONObject().put("id", "p1")))
                    "/api/notifications" -> json(code, JSONObject().put("notifications", notes))
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
    }

    @After fun tearDown() { env.close() }

    private fun json(c: Int, o: JSONObject) = MockResponse.Builder().code(c).setHeader("content-type", "application/json").body(o.toString()).build()

    private fun note(id: Long, kind: String = "episode", link: String? = "/watch/abc", read: Boolean = false, title: String = "T$id") =
        JSONObject().put("id", id).put("kind", kind).put("title", title).put("body", JSONObject.NULL)
            .put("link", link ?: JSONObject.NULL).put("read", read).put("created_at", "2026-10-20T10:00:00Z")

    private fun serve(vararg n: JSONObject) { notes = JSONArray(n.sortedByDescending { it.getLong("id") }) }

    private fun poll() = runBlocking {
        NotificationPoller(env.settings, { env.deps.api() }, poster).poll()
    }

    private fun lastId() = runBlocking { env.settings.notifyLastId(NotificationPoller.originKey(env.server.url("/"))).first() }

    @Test fun firstRunOnlySeedsTheNewestIdAndPostsNothing() {
        serve(note(5), note(9), note(7))
        poll()
        assertTrue(poster.posted.isEmpty())
        assertEquals(9L, lastId())
    }

    @Test fun firstRunWithNoNotificationsSeedsZeroSoTheNextOnesCount() {
        serve()
        poll()
        assertEquals(0L, lastId())
        serve(note(1))
        poll()
        assertEquals(1, poster.posted.size)
    }

    @Test fun twoNewItemsGiveTwoNotificationsAndARerunNone() {
        serve(note(9)); poll()
        serve(note(9), note(10, "available", "/requests"), note(11, "party_invite", "/party/r1"))
        poll()
        assertEquals(listOf(10L, 11L), poster.posted.map { it.first.id })
        assertEquals(listOf(NotifyCategory.NEW, NotifyCategory.OTHER), poster.posted.map { it.second })
        assertEquals(listOf("/requests", "/party/r1"), poster.posted.map { it.third })
        assertEquals(11L, lastId())
        poll()
        assertEquals(2, poster.posted.size)
    }

    @Test fun requestsAreSentForTheActiveProfileAndNothingIsMarkedRead() {
        serve(note(1)); poll()
        val api = seen.last { it.url.encodedPath == "/api/notifications" }
        assertEquals("p1", api.headers["x-ff-profile"])
        assertTrue(seen.none { it.method != "GET" })
    }

    @Test fun aDisabledCategoryPostsNothingButIsConsumed() {
        serve(note(1)); poll()
        runBlocking { env.settings.setNotifyCategories(setOf("requests", "other")) }
        serve(note(1), note(2, "episode"), note(3, "media_approved", "/requests"))
        poll()
        assertEquals(listOf(3L), poster.posted.map { it.first.id })
        assertEquals(3L, lastId())
        // switching the category on later does not replay the old one
        runBlocking { env.settings.setNotifyCategories(NotifyCategory.ALL_IDS) }
        poll()
        assertEquals(1, poster.posted.size)
    }

    @Test fun readOnTheWebIsNotNotifiedAgain() {
        serve(note(1)); poll()
        serve(note(1), note(2, read = true), note(3))
        poll()
        assertEquals(listOf(3L), poster.posted.map { it.first.id })
        assertEquals(3L, lastId())
    }

    @Test fun unknownKindsFallIntoOther() {
        assertEquals(NotifyCategory.OTHER, NotifyCategory.of("brand_new_kind"))
        assertEquals(NotifyCategory.REQUESTS, NotifyCategory.of("request_pending"))
        assertEquals(NotifyCategory.ACCOUNT, NotifyCategory.of("access_ended"))
    }

    @Test fun unauthorizedPostsNothingStopsPollingAndAsksOnlyOnce() {
        serve(note(1)); poll()
        meCode = 401
        serve(note(1), note(2))
        poll()
        assertTrue(poster.posted.isEmpty())
        assertTrue(runBlocking { env.settings.notifyPaused.first() })
        val before = seen.size
        poll()
        assertEquals(before, seen.size) // paused: no request at all
        assertEquals(1L, lastId())
    }

    @Test fun unauthorizedOnTheListAlsoPauses() {
        serve(note(1)); poll()
        code = 401
        poll()
        assertTrue(runBlocking { env.settings.notifyPaused.first() })
    }

    @Test fun rearmingOnAppOpenResumesPolling() {
        runBlocking { env.settings.setNotifyPaused(true) }
        serve(note(1)); poll()
        assertNull(lastId())
        runBlocking { NotificationScheduler.rearm(env.context) }
        poll()
        assertEquals(1L, lastId())
    }

    @Test fun networkErrorAndServerErrorsChangeNothing() {
        serve(note(1)); poll()
        serve(note(1), note(2))
        drop = true
        poll()
        drop = false
        for (c in listOf(500, 503, 403, 409)) { code = c; poll() }
        assertTrue(poster.posted.isEmpty())
        assertEquals(1L, lastId())
        assertFalse(runBlocking { env.settings.notifyPaused.first() })
        code = 200
        poll()
        assertEquals(listOf(2L), poster.posted.map { it.first.id })
    }

    @Test fun withoutThePermissionNothingIsPostedOrConsumedUntilItIsGranted() {
        serve(note(1)); poll()
        poster.allowed = false
        serve(note(1), note(2), note(3))
        poll()
        assertTrue(poster.posted.isEmpty())
        assertEquals(1L, lastId())
        poster.allowed = true
        poll()
        assertEquals(listOf(2L, 3L), poster.posted.map { it.first.id })
    }

    @Test fun anotherServerSeedsAgain() {
        serve(note(5)); poll()
        runBlocking { env.settings.setNotifyLastId("https://other.example:443", 100) }
        assertNull(lastId())
    }

    @Test fun theWorkerSucceedsOnEveryOutcome() {
        fun work() = runBlocking { TestListenableWorkerBuilder<NotificationWorker>(env.context).build().doWork() }
        serve(note(1))
        assertEquals(ListenableWorker.Result.success(), work())
        meCode = 401
        assertEquals(ListenableWorker.Result.success(), work())
        drop = true; meCode = 200
        assertEquals(ListenableWorker.Result.success(), work())
    }

    // ---- links ----
    private val origin = okhttp3.HttpUrl.Builder().scheme("https").host("ff.example").port(8443).build()

    @Test fun stringAndNumberIdsAreBothUnderstood() {
        // node-pg returns bigserial as a string
        serve(note(1)); poll()
        notes = JSONArray()
            .put(note(14).put("id", "14")).put(note(13)).put(note(12).put("id", "12")).put(note(1).put("id", "oops"))
        poll()
        assertEquals(listOf(12L, 13L, 14L), poster.posted.map { it.first.id })
        assertEquals(14L, lastId())
    }

    @Test fun pathsThatNormaliseToSchemeRelativeAreRejected() {
        assertNull(NotifyLinks.safePath(origin, "/.//evil"))
        assertNull(NotifyLinks.safePath(origin, "/a/..//evil"))
    }

    @Test fun theTapUrlIsRevalidated() {
        assertEquals("https://ff.example:8443/requests?x=1", NotifyLinks.urlFor(origin, "/requests?x=1"))
        assertNull(NotifyLinks.urlFor(origin, "https://evil.example/"))
        assertNull(NotifyLinks.urlFor(origin, null))
    }

    @Test fun onlyOwnOriginPathsAreAccepted() {
        assertEquals("/requests", NotifyLinks.safePath(origin, "/requests"))
        assertEquals("/watch/abc?t=30", NotifyLinks.safePath(origin, "/watch/abc?t=30#x"))
        for (bad in listOf(null, "", "requests", "//evil.example/x", "https://evil.example/", "https://ff.example:8443/x", "/\\evil.example", "/a\nb", "javascript:alert(1)", "intent://x#Intent;end", "/" + "a".repeat(600))) {
            assertNull("$bad", NotifyLinks.safePath(origin, bad))
        }
    }

    // ---- the system side ----
    @Test fun theTapIntentCarriesOnlyTheValidatedPath() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val sys = SystemNotePoster(app)
        assertTrue(sys.canPost())
        sys.post(ServerNote(42, "available", "Hello", "Body", "/requests", false), NotifyCategory.NEW, "/requests")
        val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val n = shadowOf(nm).allNotifications.single()
        assertEquals(NotifyCategory.NEW.channelId, n.channelId)
        val intent = shadowOf(n.contentIntent).savedIntent
        // the shell's non-exported entry: the exported launcher one ignores the path
        assertEquals(ShellIntents.INTERNAL, intent.component!!.className)
        assertEquals("/requests", intent.getStringExtra(ShellActivity.EXTRA_OPEN_PATH))
        assertNull(intent.data)
        assertEquals(setOf(ShellActivity.EXTRA_OPEN_PATH), intent.extras!!.keySet())
        assertTrue(shadowOf(n.contentIntent).isActivity)
    }

    @Test fun oneChannelPerCategoryWithNamesInTheAppLanguage() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Channels.ensure(app)
        val nm = app.getSystemService(NotificationManager::class.java)
        assertEquals(NotifyCategory.entries.map { it.channelId }.toSet(), nm.notificationChannels.map { it.id }.filter { it.startsWith("notify_") }.toSet())
        assertTrue(nm.notificationChannels.filter { it.id.startsWith("notify_") }.all { it.name.isNotBlank() })
    }

    @Test fun withoutThePermissionThePosterRefusesAndDoesNotCrash() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertFalse(SystemNotePoster(app).canPost())
    }

    // ---- schedule ----
    @Test fun theScheduleIsOnePeriodicJobWithFlexAndANetworkConstraint() {
        NotificationScheduler.schedule(env.context, env.workManager)
        NotificationScheduler.schedule(env.context, env.workManager) // KEEP
        val infos = env.workManager.getWorkInfosForUniqueWork(NotificationScheduler.WORK_NAME).get()
        assertEquals(1, infos.size)
        val w = infos.single()
        assertEquals(WorkInfo.State.ENQUEUED, w.state)
        assertEquals(15 * 60_000L, w.periodicityInfo!!.repeatIntervalMillis)
        assertEquals(5 * 60_000L, w.periodicityInfo!!.flexIntervalMillis)
        assertEquals(NetworkType.CONNECTED, w.constraints.requiredNetworkType)
    }
}
