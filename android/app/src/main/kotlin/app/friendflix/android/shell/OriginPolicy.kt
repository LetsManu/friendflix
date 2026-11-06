// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.net.Uri
import okhttp3.HttpUrl

/**
 * The one origin (scheme + host + port, no subdomains) that counts as "the app". Everything else is external. (The shell also uses one
 * for the server's sign-in page origin: the same exact comparison, but that one never scopes the bridge or the cookie jar.)
 * The native bridge uses [originRule] to scope the injected object and [isAppOrigin] on the listener's `sourceOrigin` for each message.
 */
class OriginPolicy(val origin: HttpUrl) {
    private val host = origin.host
    private val port = origin.port

    /** The origin as WebViewCompat.addWebMessageListener wants it: scheme://host[:port] (IPv6 hosts in brackets, default port omitted). */
    fun originRule(): String {
        val h = if (':' in host) "[$host]" else host
        return if (port == 443) "https://$h" else "https://$h:$port"
    }

    fun isAppOrigin(url: Uri): Boolean {
        if (!"https".equals(url.scheme, ignoreCase = true)) return false
        val h = url.host ?: return false
        if (!h.equals(host, ignoreCase = true)) return false
        return (if (url.port == -1) 443 else url.port) == port
    }
}
