// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import app.friendflix.android.BuildConfig
import app.friendflix.android.R
import app.friendflix.android.bridge.Capabilities
import app.friendflix.android.bridge.DownloadEntry
import app.friendflix.android.bridge.DownloadRequest
import app.friendflix.android.bridge.DownloadSink
import app.friendflix.android.bridge.NativeBridge
import app.friendflix.android.bridge.PlayRequest
import app.friendflix.android.bridge.PlayerLauncher
import app.friendflix.android.offline.NetworkWatch
import app.friendflix.android.offline.Offline
import app.friendflix.android.offline.OfflineActivity
import app.friendflix.android.offline.OfflineGate
import app.friendflix.android.player.NativePlayerLauncher
import app.friendflix.android.settings.AppSettings
import app.friendflix.android.setup.ServerProbe
import app.friendflix.android.setup.SetupActivity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

/** The app: the FriendFlix web UI of the saved server in a locked-down WebView. No saved server yet -> setup first. */
class ShellActivity : ComponentActivity() {
    /** The shell's WebView once the saved server is known (null before, and when setup was started instead). */
    internal var webView: WebView? = null
        private set
    private var bridge: NativeBridge? = null
    private var watch: NetworkWatch? = null
    private var policy: OriginPolicy? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = shellBack(webView) { finish() }
        })
        lifecycleScope.launch {
            val origin = AppSettings.from(applicationContext).serverOrigin.first()
            if (origin == null) {
                startActivity(Intent(this@ShellActivity, SetupActivity::class.java))
                finish()
                return@launch
            }
            WebViewFactory.setDebuggable(BuildConfig.DEBUG)
            val policy = OriginPolicy(origin)
            this@ShellActivity.policy = policy
            // openSettings is a no-op until the settings screen exists (Task 11).
            val offline = Offline.get(applicationContext)
            val native = NativePlayerLauncher.forApp(applicationContext)
            offline.launcher = native // the offline list plays through the same player
            val downloads = offline.downloads.queue
            downloads.resumeAll() // app start: downloads paused by a sign-out continue (one try; a 401 pauses them again)
            offline.startInBackground() // keys, licence check, position sync
            watch = NetworkWatch(this@ShellActivity) { offline.reconnectInBackground() }.also { it.start() }
            launch { openOfflineIfUnreachable(origin, offline) }
            // every hand-over from the web UI names the active profile: the offline list shows that profile's downloads
            val sink = object : DownloadSink by downloads {
                override fun enqueue(req: DownloadRequest): Boolean { offline.noteProfile(req.profileId); return downloads.enqueue(req) }
            }
            val player = object : PlayerLauncher {
                override fun launch(req: PlayRequest): Boolean { offline.noteProfile(req.profileId); return native.launch(req) }
            }
            val bridge = NativeBridge(policy, player, sink, Capabilities(play = true, download = true, cast = true), openSettings = {})
            this@ShellActivity.bridge = bridge
            launch {
                var last = emptyList<DownloadEntry>()
                downloads.observeWeb().collect { now ->
                    bridge.emitDownloadChanges(last, now)
                    last = now
                }
            }
            val view = WebViewFactory.create(
                this@ShellActivity, policy, BuildConfig.VERSION_NAME, bridge,
                onRenderGone = ::onRenderGone,
                // a page load of /watch/<id> (deep link, reload) plays natively too, for the last active profile; none known → web player
                onWatch = { link ->
                    val profile = offline.state.lastProfileId
                    profile != null && native.launch(PlayRequest(link.itemId, profile, link.startMs, null, link.audio, link.subtitle))
                },
                openExternal = ::openExternal,
            )
            ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
            webView = view
            setContentView(view)
            view.loadUrl(origin.toString())
        }
    }

    /** Start-up: a quick probe; the server cannot be used and there is something downloaded to watch → the offline list. */
    private suspend fun openOfflineIfUnreachable(origin: HttpUrl, offline: Offline) {
        val result = ServerProbe(appVersion = BuildConfig.VERSION_NAME, timeoutMs = PROBE_TIMEOUT_MS).probe(origin)
        if (OfflineGate.shouldOpen(result, offline.checker.hasDownloads()) && !isFinishing) startActivity(OfflineActivity.intent(this))
    }

    override fun onStart() {
        super.onStart()
        watch?.start()
    }

    override fun onStop() {
        watch?.stop()
        super.onStop()
    }

    /** Back from the offline list after a successful reconnect: reload the web UI (it may show the error page). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_RELOAD, false)) webView?.reload()
        intent.getStringExtra(EXTRA_WEB_WATCH)?.let(::openWebWatch)
    }

    /** The native player handed a title back (its profile is not the session's): the web UI's watch page plays it. */
    private fun openWebWatch(path: String) {
        val view = webView ?: return
        val policy = this.policy ?: return
        val url = policy.origin.resolve(path)?.toString() ?: return
        if (WatchLinks.parse(url.toUri(), policy) == null) return // only the app's own watch page
        (view.webViewClient as? ShellWebViewClient)?.allowWebOnce(url)
        view.loadUrl(url)
    }

    private fun onRenderGone() {
        // a page that keeps crashing the renderer must not loop: two restarts per process, then leave
        if (renderRestarts++ < MAX_RENDER_RESTARTS) recreate() else finish()
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(ExternalLinks.chooser(uri, getString(R.string.open_with)))
        } catch (_: android.content.ActivityNotFoundException) {
            // nothing on the device can open it; the link simply does nothing
        }
    }

    override fun onDestroy() {
        bridge?.detach() // events and replies are posted through the view: let go of it before it is destroyed
        bridge = null
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    companion object {
        /** Intent extra: reload the page (the offline list reconnected). */
        const val EXTRA_RELOAD = "app.friendflix.android.RELOAD"
        /** Intent extra: an app path `/watch/<id>?…` to open in the web player (the native player handed it back). */
        const val EXTRA_WEB_WATCH = "app.friendflix.android.WEB_WATCH"
        private const val MAX_RENDER_RESTARTS = 2
        private const val PROBE_TIMEOUT_MS = 4_000L
        private var renderRestarts = 0
    }
}

/** Android back walks the WebView history; at the first page it leaves the app. */
internal fun shellBack(view: WebView?, finish: () -> Unit) {
    if (view != null && view.canGoBack()) view.goBack() else finish()
}
