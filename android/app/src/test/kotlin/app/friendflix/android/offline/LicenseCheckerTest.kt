// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import androidx.work.WorkInfo
import app.friendflix.android.bridge.PlayRequest
import app.friendflix.android.bridge.PlayerLauncher
import app.friendflix.android.crypto.KeysUnavailableException
import app.friendflix.android.downloads.DownloadQueue
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.downloads.ITEM
import app.friendflix.android.downloads.KeySource
import app.friendflix.android.downloads.LIC
import app.friendflix.android.downloads.LIC2
import app.friendflix.android.downloads.OpenOnceKeySource
import app.friendflix.android.downloads.PROFILE
import app.friendflix.android.downloads.TestEnv
import app.friendflix.android.setup.ProbeResult
import kotlinx.coroutines.runBlocking
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
import java.io.File
import java.time.Instant

const val DAY = 86_400_000L
const val OTHER_PROFILE = "9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b5a"

class FakeLauncher(var answer: Boolean = true) : PlayerLauncher {
    val requests = mutableListOf<PlayRequest>()
    override fun launch(req: PlayRequest): Boolean { requests += req; return answer }
}

@RunWith(RobolectricTestRunner::class)
class LicenseCheckerTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private lateinit var offline: Offline
    private var clock = 1_800_000_000_000L
    private val launcher = FakeLauncher()
    private val checker get() = offline.checker

    @Before fun setUp() {
        env = TestEnv(tmp.newFolder("env"))
        offline = Offline(env.deps, tmp.newFolder("state")) { clock }
        offline.launcher = launcher
        env.fake.expiresAt = Instant.ofEpochMilli(clock + 30 * DAY)
    }

    @After fun tearDown() { env.close() }

    /** A finished download checked online [checkedAgo] ms ago; the server's offline window is the 7 days after that check. */
    private fun done(id: String = LIC, checkedAgo: Long = DAY, profile: String = PROFILE, validUntil: Long? = null): File {
        val f = env.complete(id)
        val last = clock - checkedAgo
        env.add(
            env.record(id, DownloadState.DONE).copy(
                profileId = profile, bytes = env.fake.content.size.toLong(), total = env.fake.content.size.toLong(),
                expiresAt = clock + 30 * DAY, lastCheck = last, validUntil = validUntil ?: (last + 7 * DAY), title = "Secret Movie Title",
            ),
        )
        return f
    }

    private fun checks() = env.fake.api("/api/downloads/check")

    // ---- Review Focus 4 ----

    @Test fun eightDaysOfflineRefusesPlayback() {
        val f = done(checkedAgo = 8 * DAY)
        assertEquals(PlayBlock.CHECK_IN, checker.verdict(env.store.get(LIC)!!))
        assertEquals(PlayResult.Blocked(PlayBlock.CHECK_IN), offline.play(LIC))
        assertTrue("nothing is launched", launcher.requests.isEmpty())
        assertTrue("offline: nothing is deleted", f.exists())
        assertEquals(DownloadState.DONE, env.store.get(LIC)!!.state)
    }

    @Test fun withinTheGraceWindowPlays() {
        done(checkedAgo = 6 * DAY)
        assertNull(checker.verdict(env.store.get(LIC)!!))
    }

    @Test fun graceDefaultsToSevenDaysWithoutAServerWindow() {
        done(checkedAgo = 8 * DAY, validUntil = 0)
        assertEquals(PlayBlock.CHECK_IN, checker.verdict(env.store.get(LIC)!!))
        env.store.update(LIC) { it.copy(lastCheck = clock - 6 * DAY) }
        assertNull(checker.verdict(env.store.get(LIC)!!))
    }

    @Test fun pastExpiryIsExpiredButNotDeletedOffline() {
        val f = done()
        env.store.update(LIC) { it.copy(expiresAt = clock - 1) }
        assertEquals(PlayBlock.EXPIRED, checker.verdict(env.store.get(LIC)!!))
        assertTrue(f.exists())
    }

    @Test fun onlineCheckRevokedDeletesTheFile() = runBlocking {
        val f = done()
        env.fake.checkRevoked = true
        val out = checker.check()
        assertEquals(CheckOutcome.Checked(valid = 0, revoked = listOf(LIC)), out)
        assertFalse("revoked file deleted", f.exists())
        assertEquals("row kept as expired (web parity)", DownloadState.EXPIRED, env.store.get(LIC)!!.state)
        assertEquals(PlayBlock.EXPIRED, checker.verdict(env.store.get(LIC)!!))
        assertTrue("the server already revoked it: no DELETE", env.fake.requests.none { it.method == "DELETE" })
    }

    @Test fun onlineCheckRevokedStopsARunningDownload() = runBlocking {
        env.partial(1000)
        env.add(env.record(LIC, DownloadState.DOWNLOADING).copy(bytes = 1000, expiresAt = clock + DAY))
        env.deps.queue.enqueue(app.friendflix.android.bridge.DownloadRequest(LIC, ITEM, PROFILE))
        env.deps.queue.awaitScheduled()
        env.fake.checkRevoked = true
        checker.check()
        assertEquals(DownloadState.EXPIRED, env.store.get(LIC)!!.state)
        assertFalse(env.video().exists())
        val works = env.workManager.getWorkInfosForUniqueWork(DownloadQueue.workName(LIC)).get()
        assertTrue(works.all { it.state == WorkInfo.State.CANCELLED || it.state.isFinished })
    }

    @Test fun clockSetBackRefusesPlaybackUntilAnOnlineCheck() = runBlocking {
        done()
        assertEquals(CheckOutcome.Checked(valid = 1, revoked = emptyList()), checker.check())
        assertNull(checker.verdict(env.store.get(LIC)!!))
        clock -= 4 * 60_000 // small skew is tolerated
        assertNull(checker.verdict(env.store.get(LIC)!!))
        clock -= 2 * 60_000 // now more than 5 min before the last check
        assertEquals(PlayBlock.CLOCK, checker.verdict(env.store.get(LIC)!!))
        assertEquals(PlayResult.Blocked(PlayBlock.CLOCK), offline.play(LIC))
        // online again: the server's answer lifts the block
        assertTrue(checker.check() is CheckOutcome.Checked)
        assertNull(checker.verdict(env.store.get(LIC)!!))
    }

    @Test fun clockSetBackAfterUsingTheAppOfflineIsRefused() {
        done(checkedAgo = DAY)
        clock += 2 * DAY
        checker.touch() // the app was used offline at this time
        clock -= 2 * DAY
        assertEquals(PlayBlock.CLOCK, checker.verdict(env.store.get(LIC)!!))
    }

    @Test fun anOnlineCheckLiftsTheClockGuardOfALaterSeenTime() = runBlocking {
        done()
        clock += 2 * DAY
        checker.touch() // e.g. the clock ran ahead while offline
        clock -= 2 * DAY
        assertEquals(PlayBlock.CLOCK, checker.verdict(env.store.get(LIC)!!))
        assertTrue(checker.check() is CheckOutcome.Checked)
        assertEquals(clock, offline.state.lastCheck)
        assertEquals(clock, offline.state.maxSeen)
        assertNull(checker.verdict(env.store.get(LIC)!!))
    }

    @Test fun successfulCheckRenewsTheWindow() = runBlocking {
        done(checkedAgo = 8 * DAY)
        env.fake.checkValidUntil = Instant.ofEpochMilli(clock + 7 * DAY)
        checker.check()
        val r = env.store.get(LIC)!!
        assertEquals(clock + 7 * DAY, r.validUntil)
        assertEquals(clock, r.lastCheck)
        assertNull(checker.verdict(r))
        val body = checks().single()
        assertEquals(PROFILE, body.headers["x-ff-profile"])
        assertEquals("tok", body.headers["x-csrf-token"])
    }

    // ---- keys ----

    @Test fun oldFilesUnreadableAtStartRemovesFilesAndRecords() = runBlocking {
        val f = done()
        env.partial(500, LIC2)
        env.add(env.record(LIC2, DownloadState.PAUSED).copy(bytes = 500, etag = "\"e\""))
        env.keySource = OpenOnceKeySource({ env.keys }, { true }) { env.deps.queue.dropUnreadable() }
        checker.start()
        assertFalse(f.exists())
        assertNull("finished download removed", env.store.get(LIC))
        val partial = env.store.get(LIC2)!!
        assertEquals("unfinished download restarts from 0", 0L, partial.bytes)
        assertNull(partial.etag)
        assertFalse(env.video(LIC2).exists())
        assertEquals(true, checker.keysAvailable.value)
        env.deps.queue.awaitScheduled()
        val deletes = env.workManager.getWorkInfosForUniqueWork(DownloadQueue.deleteName(LIC)).get()
        assertEquals("the licence is given back to the server", 1, deletes.size)
    }

    @Test fun keysUnavailableDeletesNothingAndShowsUnavailable() = runBlocking {
        val f = done()
        env.keySource = KeySource { throw KeysUnavailableException("keystore busy") }
        checker.start()
        assertEquals(false, checker.keysAvailable.value)
        assertTrue(f.exists())
        assertEquals(DownloadState.DONE, env.store.get(LIC)!!.state)
        assertEquals(listOf(LIC), checker.entries().map { it.licenseId })
        assertEquals(PlayBlock.KEYS_UNAVAILABLE, checker.verdict(env.store.get(LIC)!!))
    }

    // ---- failures never delete ----

    @Test fun sessionExpiredDuringCheckDeletesNothingAndIsRetriedLater() = runBlocking {
        val f = done()
        env.fake.unauthorized = true
        assertEquals(CheckOutcome.SignedOut, checker.check())
        assertTrue(f.exists())
        assertEquals(clock - DAY, env.store.get(LIC)!!.lastCheck)
        env.fake.unauthorized = false
        env.fake.checkRevoked = true
        clock += 60_000
        checker.onReconnect()
        assertEquals("retried on the next trigger", 1, checks().size)
        assertFalse(f.exists())
    }

    @Test fun networkErrorDuringCheckKeepsTheGraceOfTheLastGoodCheck() = runBlocking {
        val f = done(checkedAgo = 3 * DAY)
        env.server.close()
        assertEquals(CheckOutcome.Offline, checker.check())
        assertTrue(f.exists())
        assertNull(checker.verdict(env.store.get(LIC)!!))
        clock += 5 * DAY // 8 days since the last good check
        assertEquals(PlayBlock.CHECK_IN, checker.verdict(env.store.get(LIC)!!))
        assertTrue(f.exists())
    }

    @Test fun serverErrorDuringCheckDeletesNothing() = runBlocking {
        val f = done()
        env.fake.checkCode = 503
        assertEquals(CheckOutcome.Wait, checker.check())
        assertTrue(f.exists())
        assertEquals(clock - DAY, env.store.get(LIC)!!.lastCheck)
    }

    // ---- profiles ----

    @Test fun onlyTheActiveProfileIsCheckedAndListed() = runBlocking {
        done(LIC)
        val other = done(LIC2, profile = OTHER_PROFILE)
        env.fake.checkRevoked = true
        checker.check()
        assertEquals(DownloadState.EXPIRED, env.store.get(LIC)!!.state)
        assertTrue("other profile untouched", other.exists())
        assertEquals(DownloadState.DONE, env.store.get(LIC2)!!.state)
        assertEquals(PROFILE, offline.state.lastProfileId)
        assertEquals(listOf(LIC), checker.entries().map { it.licenseId })
        offline.noteProfile(OTHER_PROFILE)
        assertEquals(listOf(LIC2), checker.entries().map { it.licenseId })
    }

    @Test fun unknownProfileListsOnlyWhenOneProfileHasDownloads() {
        done(LIC)
        assertEquals(listOf(LIC), checker.entries().map { it.licenseId })
        done(LIC2, profile = OTHER_PROFILE)
        assertTrue(checker.entries().isEmpty())
    }

    // ---- play ----

    @Test fun playHandsTheLocalFileLicenceAndPositionToTheLauncher() {
        val f = done()
        env.store.update(LIC) { it.copy(positionMs = 61_000) }
        assertEquals(PlayResult.Started, offline.play(LIC))
        val req = launcher.requests.single()
        assertEquals(ITEM, req.itemId)
        assertEquals(PROFILE, req.profileId)
        assertEquals(61_000L, req.startMs)
        assertNotNull(req.offline)
        val media = req.offline!!
        assertEquals(LIC, media.licenseId)
        assertEquals(f.canonicalFile, media.video.canonicalFile)
    }

    @Test fun declinedLaunchIsReported() {
        done()
        launcher.answer = false
        assertEquals(PlayResult.Declined, offline.play(LIC))
    }

    @Test fun missingFileIsReported() {
        val f = done()
        f.delete()
        assertEquals(PlayResult.Blocked(PlayBlock.FILE_MISSING), offline.play(LIC))
    }

    @Test fun positionUpdatesTheRecordAndQueuesASync() {
        done()
        offline.recordPosition(LIC, 120_000, played = false)
        assertEquals(120_000L, env.store.get(LIC)!!.positionMs)
        val e = offline.sync.pending().single()
        assertEquals(1_200_000_000L, e.positionTicks)
        assertEquals(clock, e.at)
        assertEquals(PROFILE, e.profileId)
    }

    @Test fun startChecksAndSyncs() = runBlocking {
        done()
        offline.recordPosition(LIC, 5_000, played = false)
        checker.start()
        assertEquals(1, checks().size)
        assertEquals(1, env.fake.api("/api/downloads/progress").size)
        assertTrue(offline.sync.pending().isEmpty())
    }

    @Test fun reconnectIsThrottled() = runBlocking {
        done()
        checker.onReconnect()
        checker.onReconnect()
        assertEquals(1, checks().size)
        clock += 60_000
        checker.onReconnect()
        assertEquals(2, checks().size)
    }

    // ---- offline screen gate ----

    @Test fun offlineScreenOpensOnlyWhenUnreachableWithSomethingToWatch() {
        assertTrue(OfflineGate.shouldOpen(ProbeResult.Unreachable, hasDownloads = true))
        assertTrue(OfflineGate.shouldOpen(ProbeResult.TlsProblem, hasDownloads = true))
        assertTrue(OfflineGate.shouldOpen(ProbeResult.NotFriendFlix, hasDownloads = true))
        assertFalse(OfflineGate.shouldOpen(ProbeResult.Unreachable, hasDownloads = false))
        assertFalse(OfflineGate.shouldOpen(ProbeResult.Ok("2.0.0"), hasDownloads = true))
        assertFalse(OfflineGate.shouldOpen(ProbeResult.ServerTooOld, hasDownloads = true))
    }

    @Test fun hasPlayableCountsFinishedDownloadsOfTheActiveProfile() {
        assertFalse(checker.hasDownloads())
        env.add(env.record(LIC, DownloadState.QUEUED))
        assertFalse(checker.hasDownloads())
        done(LIC2)
        assertTrue(checker.hasDownloads())
    }
}
