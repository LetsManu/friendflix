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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import app.friendflix.android.BuildConfig
import app.friendflix.android.R
import app.friendflix.android.bridge.Capabilities
import app.friendflix.android.bridge.NativeBridge
import app.friendflix.android.bridge.NoDownloadSink
import app.friendflix.android.bridge.NoPlayerLauncher
import app.friendflix.android.settings.AppSettings
import app.friendflix.android.setup.SetupActivity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** The app: the FriendFlix web UI of the saved server in a locked-down WebView. No saved server yet -> setup first. */
class ShellActivity : ComponentActivity() {
    /** The shell's WebView once the saved server is known (null before, and when setup was started instead). */
    internal var webView: WebView? = null
        private set
    private var bridge: NativeBridge? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view != null && view.canGoBack()) view.goBack() else finish()
            }
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
            // Tasks 6 (downloads) and 8 (player) swap the placeholders and flip their capability flags; until then the web UI keeps
            // playing and downloading in the page. openSettings is a no-op until the settings screen exists (Task 11).
            val bridge = NativeBridge(policy, NoPlayerLauncher, NoDownloadSink, Capabilities(play = false, download = false, cast = false), openSettings = {})
            this@ShellActivity.bridge = bridge
            val view = WebViewFactory.create(
                this@ShellActivity, policy, BuildConfig.VERSION_NAME, bridge,
                onRenderGone = ::onRenderGone, openExternal = ::openExternal,
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

    private companion object {
        const val MAX_RENDER_RESTARTS = 2
        var renderRestarts = 0
    }
}
