// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.core.net.toUri
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.friendflix.android.shell.OriginPolicy
import app.friendflix.android.shell.ShellWebViewClient

object TvWebView {
    /** The WebView's own user agent plus the Fire TV marker (never `FriendFlixAndroid/`: no phone player, downloads or Cast). */
    fun userAgent(base: String, version: String, displayHeight: Int): String = "$base FriendFlixFireTV/$version FFDisplay/$displayHeight"

    /** The largest physical height among the display's modes (2160 on a 4K TV); 1080 when none is known. */
    fun displayHeight(physicalHeights: List<Int>): Int = physicalHeights.filter { it > 0 }.maxOrNull() ?: 1080

    @SuppressLint("SetJavaScriptEnabled")
    fun create(
        context: Context, policy: OriginPolicy, versionName: String, displayHeight: Int, authOrigin: OriginPolicy?,
        onRenderGone: () -> Unit, onMessage: (TvMessage) -> Unit,
    ): WebView {
        val view = WebView(context)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // the phone remote and the TV home start playback without a key press; the page is only ever the user's own server
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            userAgentString = userAgent(userAgentString, versionName, displayHeight)
        }
        view.isFocusable = true
        // A TV app never leaves for a browser: links to other sites are dropped. No native watch page.
        view.webViewClient = ShellWebViewClient(policy, onRenderGone, onWatch = null, openExternal = {}).also { it.authOrigin = authOrigin }
        view.webChromeClient = WebChromeClient()
        view.setDownloadListener { _, _, _, _, _ -> }
        installPort(view, policy, onMessage)
        return view
    }

    /** `window.FriendFlixTv`: registered before any page loads, scoped to the server origin. */
    private fun installPort(view: WebView, policy: OriginPolicy, onMessage: (TvMessage) -> Unit) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, TvMessages.PORT, setOf(policy.originRule())) { _, message, sourceOrigin, isMainFrame, _ ->
                if (!TvMessages.accept(sourceOrigin, isMainFrame, policy)) return@addWebMessageListener
                TvMessages.parse(message.data)?.let(onMessage)
            }
        } else {
            view.addJavascriptInterface(LegacyPort(view, policy, onMessage), TvMessages.PORT)
        }
    }

    /**
     * For a WebView without the message listener: the same messages through a JavaScript interface. It is visible to every frame, so
     * a message counts only while the main frame shows the app origin (checked on the main thread, where the WebView lives).
     */
    private class LegacyPort(private val view: WebView, private val policy: OriginPolicy, private val onMessage: (TvMessage) -> Unit) {
        private val main = Handler(Looper.getMainLooper())

        @JavascriptInterface
        fun postMessage(s: String) {
            val msg = TvMessages.parse(s) ?: return
            main.post {
                val url = view.url ?: return@post
                if (policy.isAppOrigin(url.toUri())) onMessage(msg)
            }
        }
    }
}
