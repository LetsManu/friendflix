// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.net.Uri
import android.webkit.WebView
import androidx.core.net.toUri
import okhttp3.HttpUrl

/** The one origin (scheme + host + port, no subdomains) that counts as "the app". Everything else is external. */
class OriginPolicy(origin: HttpUrl) {
    private val host = origin.host
    private val port = origin.port

    fun isAppOrigin(url: Uri): Boolean {
        if (!"https".equals(url.scheme, ignoreCase = true)) return false
        val h = url.host ?: return false
        if (!h.equals(host, ignoreCase = true)) return false
        return (if (url.port == -1) 443 else url.port) == port
    }

    /** Is the page currently shown in the top frame from the app origin? (JS bridge and native actions gate on this.) */
    fun isMainFrameAppOrigin(view: WebView): Boolean {
        val current = view.url ?: return false
        return isAppOrigin(current.toUri())
    }
}
