// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.core.net.toUri
import app.friendflix.android.shell.OriginPolicy
import app.friendflix.android.shell.ShellWebViewClient

/**
 * The shared origin lock plus one signal for the Fire TV shell: [onLoaded] runs when a main-frame page of the app origin finished
 * loading without an error (network, TLS or an HTTP error status). The shell marks the first-run check as done only then.
 */
// see ShellWebViewClient: the androidx.webkit lint rule does not see the inherited onRenderProcessGone
@SuppressLint("MissingOnRenderProcessGone")
class TvWebViewClient(
    private val policy: OriginPolicy,
    onRenderGone: () -> Unit,
    private val onLoaded: (url: String) -> Unit,
) : ShellWebViewClient(policy, onRenderGone, onWatch = null, openExternal = {}) {
    /** a main-frame error was reported for the load in progress */
    private var failed = false

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        failed = false
        super.onPageStarted(view, url, favicon)
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) failed = true
        super.onReceivedError(view, request, error)
    }

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
        if (request.isForMainFrame && errorResponse.statusCode >= 400) failed = true
        super.onReceivedHttpError(view, request, errorResponse)
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        failed = true
        super.onReceivedSslError(view, handler, error) // cancels: never proceeds past a certificate error
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        if (failed || url == null || !policy.isAppOrigin(url.toUri())) return
        onLoaded(url)
    }
}
