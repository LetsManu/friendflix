// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

object ExternalLinks {
    /** Web links go through a chooser so the user picks the browser; the chooser never names a component of its own. */
    fun chooser(uri: Uri, title: CharSequence): Intent {
        val view = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        return Intent.createChooser(view, title)
    }

    fun isOpenable(uri: Uri): Boolean = uri.scheme?.lowercase() in OPENABLE

    private val OPENABLE = setOf("https", "http", "mailto", "tel")
}

class ShellWebViewClient(
    private val policy: OriginPolicy,
    private val onRenderGone: () -> Unit = {},
    private val openExternal: (Uri) -> Unit,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        if (policy.isAppOrigin(uri)) return false
        // Frames inside the page are the page's business (CSP governs them); only top-level navigation leaves the app.
        if (!request.isForMainFrame) return false
        if (ExternalLinks.isOpenable(uri)) openExternal(uri)
        // javascript:, intent:, file:, content: and the like are dropped, never started.
        return true
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onRenderGone()
        return true
    }
}

object WebViewFactory {
    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context, policy: OriginPolicy, versionName: String, onRenderGone: () -> Unit = {}, openExternal: (Uri) -> Unit): WebView {
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
        view.webViewClient = ShellWebViewClient(policy, onRenderGone, openExternal)
        // Downloads go through the native bridge only; a plain WebView download request is dropped.
        view.setDownloadListener { _, _, _, _, _ -> }
        return view
    }

    fun setDebuggable(debug: Boolean) = WebView.setWebContentsDebuggingEnabled(debug)
}
