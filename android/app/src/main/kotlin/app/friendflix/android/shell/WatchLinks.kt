// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.net.Uri

/** The web UI's watch page `/watch/<id>?t=<s>&audio=<lang>&sub=<lang|off>` as the native player takes it. */
data class WatchLink(val itemId: String, val startMs: Long?, val audio: String?, val subtitle: String?)

object WatchLinks {
    private val PATH = Regex("^/watch/([A-Za-z0-9-]{1,64})/?$")
    private val TRACK = Regex("^[A-Za-z0-9_-]{1,32}$")
    /** the web watch page takes `t` only in 0 < t < 86400 s */
    private const val MAX_T = 86_400

    /** The watch link of [uri] when it is the app origin's watch page; null for anything else. Bad query values are dropped. */
    fun parse(uri: Uri, policy: OriginPolicy): WatchLink? {
        if (!policy.isAppOrigin(uri)) return null
        val m = PATH.matchEntire(uri.path ?: return null) ?: return null
        val t = uri.getQueryParameter("t")?.toDoubleOrNull()?.takeIf { it > 0 && it < MAX_T }?.let { (it.toLong()) * 1000 }
        fun track(name: String) = uri.getQueryParameter(name)?.takeIf { TRACK.matches(it) }
        return WatchLink(m.groupValues[1], t, track("audio"), track("sub"))
    }
}
