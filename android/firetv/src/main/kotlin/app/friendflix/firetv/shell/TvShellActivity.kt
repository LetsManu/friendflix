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
import androidx.lifecycle.lifecycleScope
import app.friendflix.android.shell.OriginPolicy
import app.friendflix.android.shell.origin
import app.friendflix.firetv.BuildConfig
import app.friendflix.firetv.TvSettings
import app.friendflix.firetv.setup.TvSetupActivity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

/** The server's TV interface in one full-screen WebView. The remote's Back and media keys go to the page first (see [FireTvKeys]). */
class TvShellActivity : ComponentActivity() {
    private var webView: WebView? = null
    private var origin: HttpUrl? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            val settings = TvSettings.from(applicationContext)
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
            settings.setProbedOrigin(origin.origin())
        }
    }

    private fun open(origin: HttpUrl, auth: HttpUrl?, probedOrigin: String?) {
        this.origin = origin
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val display = ContextCompat.getDisplayOrDefault(this)
        val view = TvWebView.create(
            this, OriginPolicy(origin), BuildConfig.VERSION_NAME, TvWebView.displayHeight(display.supportedModes.map { it.physicalHeight }),
            auth?.let(::OriginPolicy), ::onRenderGone, ::onMessage,
        )
        webView = view
        setContentView(view)
        view.requestFocus()
        view.loadUrl(TvStart.url(origin, probedOrigin))
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
            is TvMessage.KeepAwake ->
                if (message.on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun onRenderGone() {
        // a page that keeps crashing the renderer must not loop: two restarts per process, then leave
        if (renderRestarts++ < MAX_RENDER_RESTARTS) recreate() else finish()
    }

    override fun onStop() {
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
