// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.WebSettings
import android.webkit.WebView
import app.friendflix.android.bridge.BridgeInstaller
import app.friendflix.android.bridge.NativeBridge

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
