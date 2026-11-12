// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import app.friendflix.android.shell.OriginPolicy
import app.friendflix.android.shell.origin
import app.friendflix.firetv.BuildConfig
import app.friendflix.firetv.TvSettings
import app.friendflix.firetv.setup.TvSetupActivity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

/**
 * The server's TV interface in one full-screen WebView. The remote's Back, media and live-TV keys (channel, digits, last
 * channel, Info, Guide) go to the page first (see [FireTvKeys]).
 */
class TvShellActivity : ComponentActivity() {
    private var webView: WebView? = null
    private var origin: HttpUrl? = null
    private lateinit var settings: TvSettings
    /** the start page carries `probe=1`: the first-run check counts as done once a page of the server loaded without an error */
    private var probePending = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = TvSettings.from(applicationContext)
        lifecycleScope.launch {
            val origin = settings.serverOrigin.first()
            if (origin == null) {
                startActivity(Intent(this@TvShellActivity, TvSetupActivity::class.java))
                finish()
                return@launch
            }
            if (isFinishing || isDestroyed) return@launch
            val auth = settings.authOrigin.first()
            val probed = settings.probedOrigin.first()
            open(origin, auth, probed)
        }
    }

    /** singleTask: a new start of the running shell. If the saved server changed meanwhile, start over for it (never keep the old one). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val shown = origin ?: return // still reading the settings: onCreate's read is current
        lifecycleScope.launch {
            if (settings.serverOrigin.first()?.origin() != shown.origin() && !isFinishing) recreate()
        }
    }

    private fun open(origin: HttpUrl, auth: HttpUrl?, probedOrigin: String?) {
        this.origin = origin
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val display = ContextCompat.getDisplayOrDefault(this)
        val view = TvWebView.create(
            this, OriginPolicy(origin), BuildConfig.VERSION_NAME, TvWebView.displayHeight(display.supportedModes.map { it.physicalHeight }),
            auth?.let(::OriginPolicy), ::onRenderGone, ::onMessage, { onLoaded() },
        )
        webView = view
        setContentView(view)
        view.requestFocus()
        val start = TvStart.url(origin, probedOrigin)
        probePending = start.endsWith("&probe=1")
        view.loadUrl(start)
        // pauseTimers is process-wide: a recreated shell (renderer gone) must undo the old instance's onStop
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) view.resumeTimers() else { view.onPause(); view.pauseTimers() }
    }

    private fun onLoaded() {
        if (!probePending) return
        probePending = false
        val done = origin?.origin() ?: return
        lifecycleScope.launch { settings.setProbedOrigin(done) }
    }

    // ComponentActivity (androidx.core) marks its dispatchKeyEvent restricted; this is Activity.dispatchKeyEvent, overridden as intended.
    @SuppressLint("RestrictedApi")
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val view = webView ?: return super.dispatchKeyEvent(event)
        return when (val r = FireTvKeys.route(event.action, event.keyCode, event.repeatCount)) {
            FireTvKeys.Route.Pass -> super.dispatchKeyEvent(event)
            FireTvKeys.Route.Swallow -> true
            is FireTvKeys.Route.Dispatch -> {
                view.evaluateJavascript(FireTvKeys.script(r.key)) { result ->
                    if (r.key != FireTvKeys.BACK || webView !== view || isFinishing) return@evaluateJavascript
                    when (TvBack.after(result, view.canGoBack())) {
                        BackAction.NONE -> Unit
                        BackAction.GO_BACK -> view.goBack()
                        BackAction.EXIT -> finish()
                    }
                }
                true
            }
        }
    }

    private fun onMessage(message: TvMessage) {
        if (isFinishing) return
        when (message) {
            TvMessage.Exit -> finish()
            TvMessage.ChangeServer -> {
                val current = origin ?: return
                startActivity(TvSetupActivity.changeIntent(this, current.origin()))
                finish()
            }
            is TvMessage.KeepAwake -> {
                // a late keepAwake:1 after onStop must not put the flag back on a window in the background
                val on = TvKeepAwake.screenOn(message.on, started = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    private fun onRenderGone() {
        // a page that keeps crashing the renderer must not loop: two restarts per process, then leave
        if (renderRestarts++ < MAX_RENDER_RESTARTS) recreate() else finish()
    }

    override fun onStart() {
        super.onStart()
        webView?.let { it.onResume(); it.resumeTimers() }
    }

    /**
     * In the background (Home, another app) the page is paused: media stops, timers stop, and keep-awake is off. Paused in onStop rather
     * than onPause, so a system overlay over the shell (which only pauses the activity) does not stop playback.
     */
    override fun onStop() {
        webView?.let { it.onPause(); it.pauseTimers() }
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // the TV session survives a force stop
        CookieManager.getInstance().flush()
        super.onStop()
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    private companion object {
        const val MAX_RENDER_RESTARTS = 2
        var renderRestarts = 0
    }
}
