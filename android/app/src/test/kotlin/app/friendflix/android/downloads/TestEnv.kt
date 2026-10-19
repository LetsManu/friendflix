// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.app.Notification
import android.content.Context
import android.util.Log
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import app.friendflix.android.crypto.EncryptedReader
import app.friendflix.android.crypto.EncryptedWriter
import app.friendflix.android.crypto.KeyProvider
import app.friendflix.android.crypto.TestKeys
import app.friendflix.android.settings.AppSettings
import app.friendflix.android.settings.StorageLocation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.random.Random

const val LIC = "3f2b8c1e-9a4d-4e21-8b5f-0c1d2e3f4a5b"
const val LIC2 = "7a1c2d3e-4f50-4617-a8b9-c0d1e2f3a4b5"
const val ITEM = "0123456789abcdef0123456789abcdef"
const val PROFILE = "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9"
const val TITLE = "Secret Movie Title"

/** Two fake volumes in a temp folder: the phone (always mounted) and a removable card that tests can pull out. */
class FakeVolumes(root: File) : VolumeSource {
    val phone = File(root, "phone").apply { mkdirs() }
    val sd = File(root, "sd").apply { mkdirs() }
    @Volatile var sdMounted = true
    @Volatile var sdPresent = true

    override fun volumes(): List<Volume> = listOfNotNull(
        Volume(StorageLocation.PHONE, phone, true),
        if (sdPresent) Volume(StorageLocation.SD, if (sdMounted) sd else null, sdMounted) else null,
    )
}

class FakeCookies : CookieSource {
    val jar = mutableMapOf<String, String>()
    val written = CopyOnWriteArrayList<Pair<String, String>>()
    override fun get(url: String): String? = jar.entries.firstOrNull { url.startsWith(it.key) }?.value
    override fun set(url: String, cookie: String) { written += url to cookie }
}

class CountingNotifier : DownloadNotifier {
    @Volatile var sessionExpired = 0
    @Volatile var foregrounds = 0
    override fun foreground(licenseId: String, percent: Int): ForegroundInfo { foregrounds++; return ForegroundInfo(1, Notification()) }
    override fun sessionExpired() { sessionExpired++ }
    override fun clearSessionExpired() {}
}

/** A FriendFlix server as the downloader sees it: the licence API (backend) and /media/d (gateway, with ETag + If-Range + one Range). */
class FakeServer : Dispatcher() {
    var content: ByteArray = Random(1).nextBytes(3 * (1 shl 20) + 17)
    var etag: String? = "\"job1-${3 * (1 shl 20) + 17}\""
    var status = "pending"
    var prep = "ready"
    var percent = 100
    var expiresAt: Instant = Instant.now().plusSeconds(7 * 86400)
    var licenceCode = 200
    var licenceError = "not_found"
    var checkRevoked = false
    /** status of `POST /api/downloads/check` (200 = the verdict below) */
    var checkCode = 200
    /** the renewed offline window the check hands out (null = expiresAt, as the server caps it) */
    var checkValidUntil: Instant? = null
    /** status of `POST /api/downloads/progress` and the items the server reports as skipped (its own state is newer) */
    var progressCode = 200
    var progressSkipped = emptySet<String>()
    /** Runs when a progress post arrives, before it is answered (an event queued meanwhile). */
    @Volatile var onProgress: (() -> Unit)? = null
    /** the profile `/api/me` reports as active */
    var activeProfile = PROFILE
    var fileCode: Int? = null
    var unauthorized = false
    var subtitles = listOf("de" to "/media/Videos/$ITEM/src/Subtitles/2/0/Stream.vtt", "en" to "/media/Videos/$ITEM/src/Subtitles/3/0/Stream.sup")
    var poster: String? = "/media/Items/$ITEM/Images/Primary?maxWidth=300&quality=85"
    val fileResponses = ConcurrentLinkedQueue<MockResponse>()
    /** Runs when a /media/d request arrives, before it is answered (e.g. a delete or sign-out racing the transfer). */
    @Volatile var onFile: (() -> Unit)? = null
    val requests = CopyOnWriteArrayList<RecordedRequest>()
    val subtitleText = "WEBVTT\n\n00:00.000 --> 00:01.000\nHallo\n"
    val posterBytes: ByteArray = Random(2).nextBytes(5000)

    fun files() = requests.filter { it.url.encodedPath.startsWith("/media/d/") }
    fun api(path: String) = requests.filter { it.url.encodedPath == path }

    private fun json(code: Int, body: Any) = MockResponse.Builder().code(code).setHeader("content-type", "application/json").body(body.toString()).build()

    fun licenceJson(id: String = LIC) = JSONObject()
        .put("id", id).put("itemId", ITEM).put("status", status).put("ready", prep == "ready")
        .put("prep", JSONObject().put("status", prep).put("percent", percent).put("error", if (prep == "failed") "prep_failed" else JSONObject.NULL))
        .put("fileUrl", "/media/d/$id").put("bytes", content.size).put("quality", "hd").put("audioLang", "de")
        .put("subtitles", JSONArray().also { a -> subtitles.forEach { (l, u) -> a.put(JSONObject().put("lang", l).put("title", l).put("url", u)) } })
        .put("poster", poster ?: JSONObject.NULL).put("backdrop", JSONObject.NULL)
        .put("title", TITLE).put("profileId", PROFILE).put("expiresAt", expiresAt.toString()).put("validUntil", expiresAt.toString())

    override fun dispatch(request: RecordedRequest): MockResponse {
        requests += request
        if (unauthorized) return json(401, JSONObject().put("error", "unauthenticated"))
        val path = request.url.encodedPath
        return when {
            path == "/api/me" -> json(200, JSONObject().put("csrfToken", "tok").put("profile", JSONObject().put("id", activeProfile)))
            path == "/api/downloads/progress" -> {
                onProgress?.invoke()
                if (progressCode != 200) return json(progressCode, JSONObject().put("error", "nope"))
                val ev = JSONObject(request.body!!.utf8()).getJSONArray("events")
                val items = (0 until ev.length()).map { ev.getJSONObject(it).getString("itemId") }.distinct()
                json(200, JSONObject().put("applied", JSONArray(items.filter { it !in progressSkipped })).put("skipped", JSONArray(items.filter { it in progressSkipped })))
            }
            path == "/api/downloads/check" && checkCode != 200 -> json(checkCode, JSONObject().put("error", "nope"))
            path == "/api/downloads/check" -> {
                val ids = JSONObject(request.body!!.utf8()).getJSONArray("ids")
                val all = (0 until ids.length()).map { ids.getString(it) }
                json(200, JSONObject()
                    .put("valid", JSONArray().also { a -> if (!checkRevoked) all.forEach { a.put(JSONObject().put("id", it).put("expiresAt", expiresAt.toString()).put("validUntil", (checkValidUntil ?: expiresAt).toString())) } })
                    .put("revoked", JSONArray().also { a -> if (checkRevoked) all.forEach { a.put(it) } }))
            }
            path.endsWith("/fetched") -> json(200, JSONObject().put("ok", true))
            path.startsWith("/api/downloads/") && request.method == "DELETE" -> json(200, JSONObject().put("ok", true))
            path.startsWith("/api/downloads/") -> {
                val id = path.removePrefix("/api/downloads/")
                if (licenceCode != 200) json(licenceCode, JSONObject().put("error", licenceError)) else json(200, licenceJson(id))
            }
            path.startsWith("/media/d/") -> onFile?.invoke().let { fileResponses.poll() } ?: fileCode?.let { MockResponse.Builder().code(it).body("no").build() } ?: serve(request)
            path.endsWith(".vtt") -> MockResponse.Builder().body(subtitleText).build()
            path.endsWith(".sup") -> MockResponse.Builder().body(Buffer().write(ByteArray(100))).build()
            path.contains("/Images/") -> MockResponse.Builder().setHeader("content-type", "image/jpeg").body(Buffer().write(posterBytes)).build()
            else -> MockResponse.Builder().code(404).body("not found").build()
        }
    }

    /** The gateway's range logic: If-Range must equal the ETag for Range to apply; exactly one `bytes=N-` range. */
    private fun serve(req: RecordedRequest): MockResponse {
        val size = content.size
        val b = MockResponse.Builder().setHeader("content-type", "video/mp4").setHeader("accept-ranges", "bytes")
        etag?.let { b.setHeader("etag", it) }
        val range = req.headers["range"]
        val ifRange = req.headers["if-range"]
        if (range != null && (ifRange == null || ifRange == etag)) {
            val start = Regex("^bytes=(\\d+)-$").find(range)!!.groupValues[1].toInt()
            if (start >= size) return b.code(416).setHeader("content-range", "bytes */$size").build()
            return b.code(206).setHeader("content-range", "bytes $start-${size - 1}/$size").body(Buffer().write(content, start, size - start)).build()
        }
        return b.code(200).body(Buffer().write(content)).build()
    }
}

class TestEnv(root: File) {
    val context: Context = ApplicationProvider.getApplicationContext()
    val server = MockWebServer()
    val fake = FakeServer()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val settings = AppSettings(PreferenceDataStoreFactory.create(scope = scope) { File(root, "s.preferences_pb") })
    val volumes = FakeVolumes(File(root, "vol"))
    val keys: KeyProvider = TestKeys()
    @Volatile var keySource: KeySource = KeySource { keys }
    /** Free bytes the volumes report (null = the real free space of the temp folder). */
    @Volatile var freeSpace: Long? = null
    @Volatile var writerFactory: (File, KeyProvider) -> EncryptedWriter = { f, k -> EncryptedWriter(f, k) }
    val cookies = FakeCookies()
    val notifier = CountingNotifier()
    val store = DownloadStore(File(root, "downloads.json"))
    val workManager: WorkManager
    val locations: StorageLocations
    val deps: Downloads

    init {
        server.dispatcher = fake
        server.start()
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context, Configuration.Builder().setMinimumLoggingLevel(Log.DEBUG).setExecutor(SynchronousExecutor()).build(),
        )
        workManager = WorkManager.getInstance(context)
        locations = StorageLocations(volumes, null, { freeSpace ?: it.usableSpace }) { to -> deps.queue.move(to) }
        deps = Downloads(context, store, locations, settings, { keySource.keys() }, workManager, OkHttpClient(), cookies, notifier, scope) { f, k -> writerFactory(f, k) }
        Downloads.install(deps)
        val origin = server.url("/")
        cookies.jar["${origin.scheme}://${origin.host}:${origin.port}"] = "ff_sid=s3cret"
        runBlocking { settings.setServerOrigin(origin) }
    }

    fun close() {
        Downloads.install(null)
        scope.cancel()
        server.close()
    }

    fun dir(kind: StorageLocation = StorageLocation.PHONE) = if (kind == StorageLocation.PHONE) volumes.phone else volumes.sd

    fun video(id: String = LIC, kind: StorageLocation = StorageLocation.PHONE) = File(locations.dirIfMounted(kind) ?: File(dir(kind), "downloads"), DownloadFiles.video(id))

    fun record(id: String = LIC, state: DownloadState = DownloadState.QUEUED, etag: String? = null, kind: StorageLocation = StorageLocation.PHONE) =
        DownloadRecord(licenseId = id, itemId = ITEM, profileId = PROFILE, state = state, file = DownloadFiles.video(id), etag = etag, location = kind)

    fun add(rec: DownloadRecord = record()) = store.insertIfAbsent(rec)

    /** A download killed after [n] plaintext bytes: written and closed without finish(), like a process death. */
    fun partial(n: Int, id: String = LIC, kind: StorageLocation = StorageLocation.PHONE): File {
        val f = File(File(dir(kind), "downloads").apply { mkdirs() }, DownloadFiles.video(id))
        EncryptedWriter(f, keys).use { it.append(fake.content, 0, n) }
        return f
    }

    fun complete(id: String = LIC, kind: StorageLocation = StorageLocation.PHONE): File {
        val f = File(File(dir(kind), "downloads").apply { mkdirs() }, DownloadFiles.video(id))
        EncryptedWriter(f, keys).use { it.append(fake.content); it.finish() }
        return f
    }

    fun plaintext(f: File): ByteArray = EncryptedReader(f, keys).use { r ->
        val out = ByteArray(r.length.toInt())
        var pos = 0
        while (pos < out.size) { val n = r.read(pos.toLong(), out, pos, out.size - pos); if (n < 0) break; pos += n }
        out
    }

    fun iv(f: File): ByteArray = f.readBytes().copyOfRange(9, 25)
}
