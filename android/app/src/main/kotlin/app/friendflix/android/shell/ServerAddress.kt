// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

enum class ServerAddressError { INVALID, INSECURE }

class ServerAddressException(val error: ServerAddressError) : Exception(error.name)

/** "https://host[:port]" without the trailing slash HttpUrl.toString() adds. */
fun HttpUrl.origin(): String = "$scheme://" + (if (':' in host) "[$host]" else host) + (if (port != HttpUrl.defaultPort(scheme)) ":$port" else "")

object ServerAddress {
    /** Turns what the user typed into the https origin of the server (scheme, host, port); path, query and fragment are dropped. */
    fun normalize(input: String): Result<HttpUrl> {
        val text = input.trim()
        if (text.isEmpty()) return fail(ServerAddressError.INVALID)
        val scheme = SCHEME.find(text)?.groupValues?.get(1)?.lowercase()
        if (scheme == "http") return fail(ServerAddressError.INSECURE)
        if (scheme != null && scheme != "https") return fail(ServerAddressError.INVALID)
        val withScheme = if (scheme == null) "https://$text" else text
        val url = withScheme.toHttpUrlOrNull() ?: return fail(ServerAddressError.INVALID)
        // A server on the public internet or LAN has a dotted name or an IP; a single label can never get a certificate the
        // system trusts, so "garbage" is told apart from an address here.
        if (url.username.isNotEmpty() || url.password.isNotEmpty() || ('.' !in url.host && ':' !in url.host)) {
            return fail(ServerAddressError.INVALID)
        }
        return Result.success(HttpUrl.Builder().scheme("https").host(url.host).port(url.port).build())
    }

    private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://")

    private fun fail(e: ServerAddressError) = Result.failure<HttpUrl>(ServerAddressException(e))
}
