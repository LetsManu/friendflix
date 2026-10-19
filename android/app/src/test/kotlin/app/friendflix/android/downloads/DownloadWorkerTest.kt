// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import app.friendflix.android.crypto.EncryptedFormat
import app.friendflix.android.crypto.EncryptedWriter
import app.friendflix.android.crypto.KeysUnavailableException
import app.friendflix.android.settings.StorageLocation
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
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

@RunWith(RobolectricTestRunner::class)
class DownloadWorkerTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv

    @Before fun setUp() { env = TestEnv(tmp.root) }
    @After fun tearDown() { env.close() }

    private fun run(id: String = LIC, attempt: Int = 0, round: Int = 0): ListenableWorker.Result = runBlocking {
        TestListenableWorkerBuilder<DownloadWorker>(env.context)
            .setInputData(workDataOf(DownloadWorker.KEY_LICENSE to id, DownloadWorker.KEY_ROUND to round))
            .setRunAttemptCount(attempt)
            .build()
            .doWork()
    }

    private fun rec(id: String = LIC) = env.store.get(id)

    /** The follow-up job a run left behind (a fresh request with its own delay), or null. */
    private fun followUp(id: String = LIC): WorkInfo? =
        env.workManager.getWorkInfosForUniqueWork(DownloadQueue.workName(id)).get().singleOrNull { it.state == WorkInfo.State.ENQUEUED }

    private fun clearJobs(id: String = LIC) { env.workManager.cancelUniqueWork(DownloadQueue.workName(id)).result.get() }

    /** The run ended and planned a fresh job (backoff under our control), waiting at most [maxDelayMs]. */
    private fun assertRescheduled(r: ListenableWorker.Result, maxDelayMs: Long = 600_000): WorkInfo {
        assertEquals(ListenableWorker.Result.success(), r)
        val w = followUp() ?: throw AssertionError("no follow-up job")
        assertTrue("delay ${w.initialDelayMillis}", w.initialDelayMillis in 1..maxDelayMs)
        return w
    }

    @Test fun freshDownloadIsStoredEncryptedWithSubtitlesAndArtwork() {
        env.add()
        assertEquals(ListenableWorker.Result.success(), run())
        val r = rec()!!
        assertEquals(DownloadState.DONE, r.state)
        assertEquals(env.fake.content.size.toLong(), r.bytes)
        assertEquals(env.fake.content.size.toLong(), r.total)
        assertEquals(env.fake.etag, r.etag)
        assertEquals(TITLE, r.title)
        val video = env.video()
        assertArrayEquals(env.fake.content, env.plaintext(video))
        // text subtitle stored encrypted, the image subtitle (.sup) skipped
        assertEquals(1, r.subtitles.size)
        assertEquals("de", r.subtitles[0].lang)
        val sub = File(video.parentFile, r.subtitles[0].file)
        assertFalse(String(sub.readBytes(), Charsets.ISO_8859_1).contains("WEBVTT"))
        assertEquals(env.fake.subtitleText, String(env.plaintext(sub)))
        assertTrue(env.fake.requests.none { it.url.encodedPath.endsWith(".sup") })
        val poster = File(video.parentFile, DownloadFiles.poster(LIC))
        assertArrayEquals(env.fake.posterBytes, env.plaintext(poster))
        // no titles in file names; only licence-based names
        video.parentFile!!.listFiles()!!.forEach { assertTrue(it.name, it.name.startsWith(LIC)); assertFalse(it.name.contains("Secret")) }
        // the server learns the file is fetched, with csrf + profile headers
        val fetched = env.fake.api("/api/downloads/$LIC/fetched").single()
        assertEquals("tok", fetched.headers["x-csrf-token"])
        assertEquals(PROFILE, fetched.headers["x-ff-profile"])
        assertTrue(fetched.body!!.utf8().contains("\"bytes\":${env.fake.content.size}"))
        assertEquals(PROFILE, env.fake.api("/api/downloads/$LIC").first().headers["x-ff-profile"])
        assertTrue(env.notifier.foregrounds > 0)
    }

    // Review Focus 2: killed at 99 %, resumed by Range pinned with If-Range, final file verifies.
    @Test fun resumeAfterKillAt99PercentUsesRangeAndIfRange() {
        val n = env.fake.content.size * 99 / 100
        val f = env.partial(n)
        val ivBefore = env.iv(f)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        assertEquals(ListenableWorker.Result.success(), run())
        val req = env.fake.files().single()
        val offset = Regex("^bytes=(\\d+)-$").find(req.headers["range"]!!)!!.groupValues[1].toLong()
        assertTrue("resumes from a verified record boundary, not from 0", offset > 0 && offset <= n)
        assertEquals(env.fake.etag, req.headers["if-range"])
        assertArrayEquals(ivBefore, env.iv(f)) // same file, same IV: only the missing bytes were appended
        assertArrayEquals(env.fake.content, env.plaintext(f)) // every record's HMAC verified while reading
        assertEquals(DownloadState.DONE, rec()!!.state)
    }

    @Test fun resumeAnswered200RestartsWithNewWriterNeverAppends() {
        val f = env.partial(2 * (1 shl 20) + 5)
        val ivBefore = env.iv(f)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = "\"old-etag\"")) // the source changed since: If-Range fails -> 200
        assertEquals(ListenableWorker.Result.success(), run())
        assertEquals("\"old-etag\"", env.fake.files().single().headers["if-range"])
        assertFalse("new IV for the new content", ivBefore.contentEquals(env.iv(f)))
        assertArrayEquals(env.fake.content, env.plaintext(f))
        assertEquals(env.fake.etag, rec()!!.etag)
    }

    @Test fun partialWithoutEtagCannotBePinnedAndRestarts() {
        val f = env.partial(2 * (1 shl 20))
        val ivBefore = env.iv(f)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = null))
        assertEquals(ListenableWorker.Result.success(), run())
        assertNull(env.fake.files().single().headers["range"])
        assertFalse(ivBefore.contentEquals(env.iv(f)))
        assertArrayEquals(env.fake.content, env.plaintext(f))
    }

    @Test fun contentRangeStartMismatchRestartsTheFile() {
        val f = env.partial(2 * (1 shl 20))
        val ivBefore = env.iv(f)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        val size = env.fake.content.size
        env.fake.fileResponses += MockResponse.Builder().code(206).setHeader("etag", env.fake.etag!!)
            .setHeader("content-range", "bytes 5-${size - 1}/$size").body(Buffer().write(env.fake.content, 5, size - 5)).build()
        assertEquals(ListenableWorker.Result.success(), run())
        val files = env.fake.files()
        assertEquals(2, files.size)
        assertNotNull(files[0].headers["range"])
        assertNull("the restart fetches from 0", files[1].headers["range"])
        assertFalse(ivBefore.contentEquals(env.iv(f)))
        assertArrayEquals(env.fake.content, env.plaintext(f))
    }

    @Test fun etagChangedOn206RestartsTheFile() {
        val f = env.partial(2 * (1 shl 20))
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        val size = env.fake.content.size
        val start = 2 * (1 shl 20)
        env.fake.fileResponses += MockResponse.Builder().code(206).setHeader("etag", "\"other\"")
            .setHeader("content-range", "bytes $start-${size - 1}/$size").body(Buffer().write(env.fake.content, start, size - start)).build()
        assertEquals(ListenableWorker.Result.success(), run())
        assertNull(env.fake.files()[1].headers["range"])
        assertArrayEquals(env.fake.content, env.plaintext(f))
    }

    @Test fun alreadyCompleteFileIsNotFetchedAgain() {
        env.complete()
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        assertEquals(ListenableWorker.Result.success(), run())
        assertTrue(env.fake.files().isEmpty())
        assertEquals(DownloadState.DONE, rec()!!.state)
    }

    @Test fun preparingRetriesAndDeletesNothing() {
        env.fake.prep = "preparing"
        env.fake.percent = 40
        env.add()
        assertRescheduled(run())
        assertEquals(DownloadState.PREPARING, rec()!!.state)
        assertTrue(env.fake.files().isEmpty())
        val entry = env.deps.queue.list().single()
        assertEquals("preparing", entry.state)
        assertEquals(0.4, entry.progress, 0.001)
    }

    @Test fun failedPreparationIsAnErrorWithoutRetryLoop() {
        env.fake.prep = "failed"
        env.add()
        assertEquals(ListenableWorker.Result.failure(), run())
        assertEquals(DownloadState.ERROR, rec()!!.state)
    }

    @Test fun gateway404WhileServerSaysActiveAndReadyRetriesWithoutDeleting() {
        val f = env.partial(1 shl 20)
        val len = f.length()
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        env.fake.fileCode = 404
        assertRescheduled(run())
        assertTrue(f.exists())
        assertEquals(len, f.length())
        assertNotNull(rec())
        assertEquals(1, env.fake.api("/api/downloads/check").size) // R7: asked the backend, which says valid
    }

    @Test fun revokedLicenceDeletesTheFile() {
        val f = env.partial(1 shl 20)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        env.fake.fileCode = 403
        env.fake.status = "revoked"
        assertEquals(ListenableWorker.Result.success(), run())
        assertFalse(f.exists())
        assertEquals(DownloadState.EXPIRED, rec()!!.state)
        assertEquals("expired", env.deps.queue.list().single().state)
    }

    @Test fun checkSaysRevokedAfterGateway410DeletesTheFile() {
        val f = env.partial(1 shl 20)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        env.fake.fileCode = 410
        env.fake.checkRevoked = true
        assertEquals(ListenableWorker.Result.success(), run())
        assertFalse(f.exists())
        assertEquals(DownloadState.EXPIRED, rec()!!.state)
    }

    @Test fun licenceGoneOnServerRemovesTheDownload() {
        val f = env.partial(1 shl 20)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        env.fake.licenceCode = 404
        assertEquals(ListenableWorker.Result.success(), run())
        assertFalse(f.exists())
        assertNull(rec())
    }

    @Test fun downloadsDisabled404IsNotAGoneLicence() {
        val f = env.partial(1 shl 20)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        env.fake.licenceCode = 404
        env.fake.licenceError = "downloads_disabled"
        assertRescheduled(run())
        assertTrue(f.exists())
        assertNotNull(rec())
    }

    @Test fun expiredLicenceDeletesTheFile() {
        val f = env.partial(1 shl 20)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        env.fake.expiresAt = java.time.Instant.now().minusSeconds(60)
        assertEquals(ListenableWorker.Result.success(), run())
        assertFalse(f.exists())
        assertEquals(DownloadState.EXPIRED, rec()!!.state)
    }

    @Test fun otherActiveProfileWaits() {
        env.add()
        env.fake.licenceCode = 409
        env.fake.licenceError = "profile_changed"
        assertRescheduled(run())
        assertNotNull(rec())
        assertTrue(env.fake.files().isEmpty())
    }

    // Review Focus 5: 401 -> every download paused, one notification, no retry loop (exactly one request, failure = no backoff run).
    @Test fun sessionExpiredPausesAllWithOneRequestAndOneNotification() {
        env.add()
        env.add(env.record(id = LIC2))
        env.fake.unauthorized = true
        assertEquals(ListenableWorker.Result.failure(), run())
        assertEquals(1, env.fake.requests.size)
        assertEquals(DownloadState.SIGNED_OUT, rec()!!.state)
        assertEquals(DownloadState.SIGNED_OUT, rec(LIC2)!!.state)
        assertEquals(1, env.notifier.sessionExpired)
        assertEquals("paused", env.deps.queue.list().first().state)
        // a later run of the other licence (already queued before) does not hit the server again
        assertEquals(ListenableWorker.Result.failure(), run(LIC2))
        assertEquals(1, env.fake.requests.size)
        assertEquals(1, env.notifier.sessionExpired)
    }

    @Test fun sessionExpiredDuringTheFileRequestPausesToo() {
        val f = env.partial(1 shl 20)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        env.fake.fileCode = 401
        assertEquals(ListenableWorker.Result.failure(), run())
        assertTrue(f.exists())
        assertEquals(DownloadState.SIGNED_OUT, rec()!!.state)
        assertEquals(1, env.notifier.sessionExpired)
    }

    @Test fun keysUnavailablePausesAndDeletesNothing() {
        val f = env.partial(1 shl 20)
        val bytes = f.readBytes()
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        env.keySource = KeySource { throw KeysUnavailableException("keystore unavailable", null) }
        assertRescheduled(run())
        assertEquals(DownloadState.PAUSED, rec()!!.state)
        assertArrayEquals(bytes, f.readBytes())
        assertTrue(env.fake.requests.isEmpty())
    }

    @Test fun unmountedCardWaitsAndDeletesNothing() {
        env.partial(1 shl 20, kind = StorageLocation.SD)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag, kind = StorageLocation.SD))
        env.volumes.sdMounted = false
        assertRescheduled(run())
        assertNotNull(rec())
        assertTrue(File(File(env.volumes.sd, "downloads"), DownloadFiles.video(LIC)).exists())
        assertTrue(env.fake.requests.isEmpty())
    }

    @Test fun newDownloadGoesToTheChosenLocation() {
        runBlocking { env.settings.setStorage(StorageLocation.SD) }
        env.add()
        assertEquals(ListenableWorker.Result.success(), run())
        assertEquals(StorageLocation.SD, rec()!!.location)
        assertArrayEquals(env.fake.content, env.plaintext(env.video(kind = StorageLocation.SD)))
    }

    @Test fun serverErrorRetries() {
        env.add()
        env.fake.fileCode = 503
        assertRescheduled(run())
        assertNotNull(rec())
    }

    @Test fun deletedRecordIsNotDownloaded() {
        assertEquals(ListenableWorker.Result.success(), run())
        assertTrue(env.fake.requests.isEmpty())
    }

    @Test fun exactChunkMultipleResumesToTheEnd() {
        env.fake.content = kotlin.random.Random(3).nextBytes(2 * (1 shl 20))
        env.fake.etag = "\"job2\""
        val f = env.partial(env.fake.content.size)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        assertEquals(ListenableWorker.Result.success(), run())
        assertArrayEquals(env.fake.content, env.plaintext(f))
        assertTrue(f.length() > EncryptedFormat.HEADER_SIZE)
    }
    // ---- fix round 1 ----

    @Test fun prepPollingStartsAt30sAndIsCappedAtFiveMinutes() {
        env.fake.prep = "preparing"
        env.add()
        assertEquals(30_000, assertRescheduled(run(round = 0)).initialDelayMillis)
        clearJobs()
        assertEquals(60_000, assertRescheduled(run(round = 1)).initialDelayMillis)
        clearJobs()
        assertEquals(300_000, assertRescheduled(run(round = 10)).initialDelayMillis)
    }

    @Test fun failuresWithoutProgressBackOffUpToTenMinutes() {
        env.add()
        env.fake.fileCode = 503
        assertEquals(30_000, assertRescheduled(run(round = 0)).initialDelayMillis)
        clearJobs()
        assertEquals(240_000, assertRescheduled(run(round = 3)).initialDelayMillis)
        clearJobs()
        assertEquals(600_000, assertRescheduled(run(round = 20)).initialDelayMillis)
    }

    @Test fun aRunThatMovedBytesForwardResetsTheBackoff() {
        val mib = 1 shl 20
        val f = env.partial(mib)
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        val size = env.fake.content.size
        env.fake.fileResponses += MockResponse.Builder().code(206).setHeader("etag", env.fake.etag!!)
            .setHeader("content-range", "bytes $mib-${size - 1}/$size").body(Buffer().write(env.fake.content, mib, mib)).build() // cut short
        assertEquals(30_000, assertRescheduled(run(round = 8)).initialDelayMillis)
        clearJobs()
        assertEquals(ListenableWorker.Result.success(), run())
        assertEquals("bytes=${2 * mib}-", env.fake.files().last().headers["range"]) // the bytes of the cut run were kept
        assertArrayEquals(env.fake.content, env.plaintext(f))
    }

    @Test fun preparationBecomingReadyResetsTheBackoff() {
        env.add(env.record(state = DownloadState.PREPARING))
        env.fake.fileCode = 503
        assertEquals(30_000, assertRescheduled(run(round = 7)).initialDelayMillis)
    }

    @Test fun signOutDuringTheRunIsNotOverwrittenAndPlansNothing() {
        env.add()
        env.fake.fileCode = 503
        env.fake.onFile = { env.store.update(LIC) { it.copy(state = DownloadState.SIGNED_OUT) } } // another worker's 401
        run()
        assertEquals(DownloadState.SIGNED_OUT, rec()!!.state)
        assertNull(followUp())
    }

    @Test fun revokeDuringTheRunIsNotOverwritten() {
        env.add()
        env.fake.fileCode = 503
        env.fake.onFile = { env.store.update(LIC) { it.copy(state = DownloadState.EXPIRED) } }
        run()
        assertEquals(DownloadState.EXPIRED, rec()!!.state)
        assertNull(followUp())
    }

    @Test fun a206WithoutEtagIsNotPinnedAndRestarts() {
        val f = env.partial(2 * (1 shl 20))
        env.add(env.record(state = DownloadState.DOWNLOADING, etag = env.fake.etag))
        val size = env.fake.content.size
        val start = 2 * (1 shl 20)
        env.fake.fileResponses += MockResponse.Builder().code(206)
            .setHeader("content-range", "bytes $start-${size - 1}/$size").body(Buffer().write(env.fake.content, start, size - start)).build()
        assertEquals(ListenableWorker.Result.success(), run())
        assertNull(env.fake.files()[1].headers["range"])
        assertArrayEquals(env.fake.content, env.plaintext(f))
    }

    @Test fun deleteWhileDownloadingStopsAndLeavesNoFile() {
        env.add()
        env.fake.onFile = { env.deps.queue.delete(LIC) }
        assertEquals(ListenableWorker.Result.success(), run())
        runBlocking { env.deps.queue.awaitScheduled() }
        assertNull(rec())
        assertFalse(env.video().exists())
        assertNull(followUp())
    }

    @Test fun diskFullFailsWithAReasonInsteadOfRetryingForever() {
        env.add()
        env.writerFactory = { _, _ -> throw java.io.IOException("write failed: ENOSPC (No space left on device)") }
        assertEquals(ListenableWorker.Result.failure(), run())
        assertEquals(DownloadState.ERROR, rec()!!.state)
        assertEquals("noSpace", rec()!!.error)
        assertEquals("noSpace", env.deps.queue.list().single().error)
        assertNull(followUp())
    }

    @Test fun unwritableLocationFailsWithIoReason() {
        env.add()
        env.writerFactory = { _, _ -> throw java.io.IOException("EACCES (Permission denied)") }
        assertEquals(ListenableWorker.Result.failure(), run())
        assertEquals(DownloadState.ERROR, rec()!!.state)
        assertEquals("io", rec()!!.error)
        assertNull(followUp())
    }

    @Test fun notEnoughFreeSpaceIsReportedBeforeFetching() {
        env.add()
        env.freeSpace = 1000
        assertEquals(ListenableWorker.Result.failure(), run())
        assertEquals(DownloadState.ERROR, rec()!!.state)
        assertEquals("noSpace", rec()!!.error)
        assertTrue(env.fake.files().isEmpty())
    }

    @Test fun bodyWithoutLengthIsCheckedAgainstTheLicenceSize() {
        env.add()
        env.fake.fileResponses += MockResponse.Builder().code(200).setHeader("etag", env.fake.etag!!)
            .chunkedBody(Buffer().write(env.fake.content, 0, 1 shl 20), 64 * 1024).build()
        assertRescheduled(run())
        assertFalse(EncryptedWriter(env.video(), env.keys).use { it.isComplete })
    }
}
