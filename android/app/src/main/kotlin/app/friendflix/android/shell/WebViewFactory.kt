// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.net.toUri
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import app.friendflix.android.bridge.BridgeInstaller
import app.friendflix.android.bridge.NativeBridge

object ExternalLinks {
    /** Web links go through a chooser so the user picks the browser; the chooser never names a component of its own. */
    fun chooser(uri: Uri, title: CharSequence): Intent {
        val view = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        return Intent.createChooser(view, title)
    }

    fun isOpenable(uri: Uri): Boolean = uri.scheme?.lowercase() in OPENABLE

    private val OPENABLE = setOf("https", "http", "mailto", "tel")
}

// The androidx.webkit lint rule (pulled in with the bridge dependency) does not see the override below; it is there and returns true.
@SuppressLint("MissingOnRenderProcessGone")
class ShellWebViewClient(
    private val policy: OriginPolicy,
    private val onRenderGone: () -> Unit = {},
    /**
     * The native player for a page load of the watch page (`/watch/<id>`: link, deep link, reload): true = it plays, the WebView
     * stays where it was; false = the web player loads. In-page navigation (the web UI's own router) never comes through here.
     */
    private val onWatch: ((WatchLink) -> Boolean)? = null,
    private val openExternal: (Uri) -> Unit,
) : WebViewClient() {
    /** The watch URL whose native start was declined: its page load goes ahead without asking again. */
    private var declined: String? = null

    /**
     * The server's sign-in page (`authOrigin` of /api/version: the identity provider), or null. The one other origin the main frame may
     * show, so that sign-in, re-authentication and the forgotten-PIN reset finish inside the app. Exact scheme + host + port, https
     * only. It never gets the bridge (the message listener is scoped to the app origin) and never sees the native cookie jar.
     */
    @Volatile
    var authOrigin: OriginPolicy? = null

    private fun isAuthOrigin(uri: Uri): Boolean = authOrigin?.isAppOrigin(uri) == true

    /** [url] is to load in the web player (the native player handed it back): its next page load is not intercepted. */
    fun allowWebOnce(url: String) { declined = url }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        if (policy.isAppOrigin(uri)) return request.isForMainFrame && nativeWatch(uri, rememberDecline = true)
        // Frames inside the page are the page's business (CSP governs them); only top-level navigation leaves the app.
        if (!request.isForMainFrame) return false
        if (isAuthOrigin(uri)) return false // sign-in at the identity provider stays in the app
        if (ExternalLinks.isOpenable(uri)) openExternal(uri)
        // javascript:, intent:, file:, content: and the like are dropped, never started.
        return true
    }

    /** Last main-frame URL the WebView committed to history. Readable from any thread. (The native bridge does not use it: it checks the frame and origin the WebMessageListener reports.) */
    @Volatile
    var committedUrl: String? = null
        private set

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        committedUrl = url
    }

    /**
     * Backstop for navigations that skip shouldOverrideUrlLoading (form POSTs, some redirects): a foreign origin (anything but the app
     * and [authOrigin]) never stays in the main frame. The load is cancelled and links are handed out; if a foreign page had already committed, step back or reload.
     */
    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        if (url == null || url == "about:blank") return
        val uri = url.toUri()
        if (policy.isAppOrigin(uri)) {
            // loadUrl / reload / history loads skip shouldOverrideUrlLoading: a watch page is handed to the native player here
            if (nativeWatch(uri, rememberDecline = false)) {
                view.stopLoading()
                if (view.canGoBack()) view.goBack() else view.loadUrl(policy.origin.toString())
            }
            return
        }
        if (isAuthOrigin(uri)) return
        view.stopLoading()
        if (ExternalLinks.isOpenable(uri)) openExternal(uri)
        val current = view.url
        // the app (or the sign-in page) is still showing: nothing to undo
        if (current != null && current.toUri().let { policy.isAppOrigin(it) || isAuthOrigin(it) }) return
        if (view.canGoBack()) view.goBack() else view.loadUrl(policy.origin.toString())
    }

    /**
     * True when [uri] is the watch page and the native player took it. A link declined in shouldOverrideUrlLoading is remembered so
     * that the page load right after it ([onPageStarted]) goes ahead without asking twice.
     */
    private fun nativeWatch(uri: Uri, rememberDecline: Boolean): Boolean {
        val watch = onWatch ?: return false
        val link = WatchLinks.parse(uri, policy) ?: return false
        val url = uri.toString()
        if (declined == url) { declined = null; return false }
        declined = null
        if (watch(link)) return true
        if (rememberDecline) declined = url
        return false
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onRenderGone()
        return true
    }
}

/**
 * Passkeys (WebAuthn) in the WebView, where its provider supports it: in app mode the WebView asks Android's credential manager, which
 * gives the page only passkeys of a relying party that has linked this app (Digital Asset Links, see docs/android.md). Without that
 * link, or on an older WebView, passkey sign-in is simply not offered and password sign-in works as before.
 */
object Passkeys {
    fun enable(
        settings: WebSettings,
        supported: Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION),
        set: (WebSettings, Int) -> Unit = WebSettingsCompat::setWebAuthenticationSupport,
    ): Boolean {
        if (!supported) return false
        set(settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
        return true
    }
}

object WebViewFactory {
    @SuppressLint("SetJavaScriptEnabled")
    fun create(
        context: Context, policy: OriginPolicy, versionName: String, bridge: NativeBridge? = null, authOrigin: OriginPolicy? = null,
        onRenderGone: () -> Unit = {}, onWatch: ((WatchLink) -> Boolean)? = null, fullscreen: FullscreenVideo? = null, openExternal: (Uri) -> Unit,
    ): WebView {
        val view = WebView(context)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            userAgentString = "$userAgentString FriendFlixAndroid/$versionName"
        }
        Passkeys.enable(view.settings)
        view.webViewClient = ShellWebViewClient(policy, onRenderGone, onWatch, openExternal).also { it.authOrigin = authOrigin }
        view.webChromeClient = ShellChromeClient(fullscreen)
        // Downloads go through the native bridge only; a plain WebView download request is dropped.
        view.setDownloadListener { _, _, _, _, _ -> }
        // Registered before any page loads. Without WebView support there is simply no bridge (the web UI then never offers native paths).
        if (bridge != null) BridgeInstaller.install(view, policy, bridge)
        return view
    }

    fun setDebuggable(debug: Boolean) = WebView.setWebContentsDebuggingEnabled(debug)
}
