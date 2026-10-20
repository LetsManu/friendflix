// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.bridge

import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.friendflix.android.shell.OriginPolicy

/**
 * Registers `window.FriendFlixNative` (postMessage / onmessage) in the page. Unlike addJavascriptInterface this object exists only
 * in frames of the app origin, and the listener learns which frame is calling, so [NativeBridge] can refuse sub-frames.
 * Without WEB_MESSAGE_LISTENER support (very old WebView) nothing is registered and the web UI keeps its own play/download paths.
 */
object BridgeInstaller {
    const val OBJECT_NAME = "FriendFlixNative"

    /** @return whether the bridge is installed. Call before the first page load so the object is in every document. */
    fun install(view: WebView, policy: OriginPolicy, bridge: NativeBridge): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        WebViewCompat.addWebMessageListener(view, OBJECT_NAME, setOf(policy.originRule())) { _, message: WebMessageCompat, sourceOrigin, isMainFrame, replyProxy: JavaScriptReplyProxy ->
            val data = message.data ?: return@addWebMessageListener // binary messages are not part of the protocol
            // JavaScriptReplyProxy is only safe on the thread that delivered the message (the UI thread); events are posted back there
            val sink = ReplySink { json -> view.post { replyProxy.postMessage(json) } }
            bridge.onMessage(data, sourceOrigin, isMainFrame, sink)
        }
        return true
    }
}
