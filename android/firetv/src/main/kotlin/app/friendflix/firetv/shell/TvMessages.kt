// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import android.net.Uri
import app.friendflix.android.shell.OriginPolicy

/** What the page may ask of the shell through `window.FriendFlixTv.postMessage`. */
sealed interface TvMessage {
    /** leave the app (Back on the TV home with the menu open) */
    data object Exit : TvMessage
    /** open the start screen's form prefilled with the current server (Back on the unpaired pairing page) */
    data object ChangeServer : TvMessage
    /** keep the screen on while the web player plays */
    data class KeepAwake(val on: Boolean) : TvMessage
}

object TvMessages {
    /** the page-side object name: `window.FriendFlixTv` */
    const val PORT = "FriendFlixTv"

    /** Exact strings only; anything else is ignored. */
    fun parse(raw: String?): TvMessage? = when (raw) {
        "exit" -> TvMessage.Exit
        "changeServer" -> TvMessage.ChangeServer
        "keepAwake:1" -> TvMessage.KeepAwake(true)
        "keepAwake:0" -> TvMessage.KeepAwake(false)
        else -> null
    }

    /** Only the server's own page in the main frame may talk to the shell (never a frame, never the sign-in page). */
    fun accept(sourceOrigin: Uri, isMainFrame: Boolean, policy: OriginPolicy): Boolean = isMainFrame && policy.isAppOrigin(sourceOrigin)
}

object TvKeepAwake {
    /**
     * Whether the screen stays on after a `keepAwake` message: only while the shell is at least started. A page that is still running
     * after onStop (a late `keepAwake:1`) must not put the flag back on a window in the background.
     */
    fun screenOn(on: Boolean, started: Boolean): Boolean = on && started
}
