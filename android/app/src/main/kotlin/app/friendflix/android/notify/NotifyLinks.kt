// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.notify

import okhttp3.HttpUrl

/** What a notification may open: a path (and query) of the app's own origin, never an arbitrary URL. */
object NotifyLinks {
    private const val MAX = 512

    /**
     * The `/path?query` of [link] when it is an absolute path on [origin] (the server sends app paths like `/requests`); null for
     * anything else: other hosts, `//host`, relative or backslash forms, control characters, over-long values. The fragment is dropped.
     */
    fun safePath(origin: HttpUrl, link: String?): String? {
        if (link == null || link.length > MAX || !link.startsWith("/") || link.startsWith("//")) return null
        if (link.any { it == '\\' || it.code < 0x20 || it.code == 0x7f }) return null
        val u = origin.resolve(link) ?: return null
        if (u.scheme != origin.scheme || u.host != origin.host || u.port != origin.port) return null
        return u.encodedPath + (u.encodedQuery?.let { "?$it" } ?: "")
    }
}
