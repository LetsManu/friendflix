// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import app.friendflix.android.shell.origin
import okhttp3.HttpUrl

object TvStart {
    /** The server's TV start page; `probe=1` the first time the shell opens for this server (the first-run playback check). */
    fun url(origin: HttpUrl, probedOrigin: String?): String {
        val o = origin.origin()
        return "$o/tv?ff_app=firetv" + if (probedOrigin != o) "&probe=1" else ""
    }
}
