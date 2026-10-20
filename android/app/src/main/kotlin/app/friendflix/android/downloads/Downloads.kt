// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.annotation.SuppressLint
import android.content.Context
import androidx.annotation.VisibleForTesting
import androidx.work.WorkManager
import app.friendflix.android.crypto.EncryptedWriter
import app.friendflix.android.crypto.KeyProvider
import app.friendflix.android.crypto.KeystoreKeyProvider
import app.friendflix.android.crypto.KeysUnavailableException
import app.friendflix.android.settings.AppSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import okhttp3.OkHttpClient
import java.io.File

/** The download keys; throws [KeysUnavailableException] while the Keystore cannot give them (downloads pause, nothing is deleted). */
fun interface KeySource {
    fun keys(): KeyProvider
}

/**
 * Opens keys once per process; a failed open ([KeysUnavailableException]) is retried on the next call. When the opened keys cannot
 * read the files written before ([unreadable], e.g. the Keystore key was lost), [onOldFilesUnreadable] runs once, inside the open and
 * before any caller gets the keys: no writer can have used the new keys yet, so every file on disk is an old, unreadable one.
 */
open class OpenOnceKeySource<K : KeyProvider>(
    private val open: () -> K,
    private val unreadable: (K) -> Boolean,
    private val onOldFilesUnreadable: () -> Unit,
) : KeySource {
    @Volatile private var opened: K? = null

    override fun keys(): KeyProvider = opened ?: synchronized(this) {
        opened ?: open().also { k ->
            if (unreadable(k)) onOldFilesUnreadable()
            opened = k
        }
    }

    /** The provider if it is already open. */
    fun current(): K? = opened

    /** The keys were wiped (sign-out of this device): the next [keys] call opens (creates) them again. */
    fun forget() { synchronized(this) { opened = null } }
}

/** The Keystore keys (Task 5). Lost keys make the old downloads unreadable: [onOldFilesUnreadable] removes them (Task 7). */
class KeystoreKeySource(context: Context, onOldFilesUnreadable: () -> Unit) :
    OpenOnceKeySource<KeystoreKeyProvider>({ KeystoreKeyProvider.open(context) }, { it.oldFilesUnreadable }, onOldFilesUnreadable)

/**
 * Everything the downloader needs, wired once per process ([get]); tests [install] their own. Workers created by WorkManager pick
 * the current instance up.
 */
class Downloads(
    val context: Context,
    val store: DownloadStore,
    val locations: StorageLocations,
    val settings: AppSettings,
    val keys: KeySource,
    val workManager: WorkManager,
    val http: OkHttpClient,
    val cookies: CookieSource,
    val notifier: DownloadNotifier,
    val scope: CoroutineScope,
    /** Opens the encrypted file a download writes (tests inject failing writers). */
    val newWriter: (File, KeyProvider) -> EncryptedWriter = { f, k -> EncryptedWriter(f, k) },
) {
    val queue = DownloadQueue(this)

    /** The API of the configured server, or null when no server is set up. */
    suspend fun api(): ServerApi? = settings.serverOrigin.first()?.let { ServerApi(it, http, cookies) }

    companion object {
        @SuppressLint("StaticFieldLeak") // holds the application context only
        @Volatile private var instance: Downloads? = null

        fun get(context: Context): Downloads = instance ?: synchronized(this) {
            instance ?: create(context.applicationContext).also { instance = it }
        }

        @VisibleForTesting
        fun install(d: Downloads?) { instance = d }

        private fun create(app: Context): Downloads {
            val settings = AppSettings.from(app)
            lateinit var d: Downloads
            val locations = StorageLocations(StorageLocations.system(app), app, null) { to -> d.queue.move(to) }
            d = Downloads(
                context = app,
                store = DownloadStore(File(app.filesDir, "downloads.json")),
                locations = locations,
                settings = settings,
                keys = KeystoreKeySource(app) { d.queue.dropUnreadable() },
                workManager = WorkManager.getInstance(app),
                http = OkHttpClient(),
                cookies = WebViewCookies(),
                notifier = SystemDownloadNotifier(app),
                scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
            )
            return d
        }
    }
}
