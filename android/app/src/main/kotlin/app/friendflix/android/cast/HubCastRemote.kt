// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import androidx.media3.common.util.UnstableApi
import app.friendflix.android.bridge.CastRemote

/**
 * The web UI's handle on the app's cast ([CastHub]): reads the snapshot, drives the receiver's player and ends the cast.
 * Main thread only (the bridge's calls). [openRemote] starts the native player as the remote of the snapshot's item,
 * [profileNoted] hands a switched-to profile on (the offline list follows it too).
 */
@OptIn(UnstableApi::class)
class HubCastRemote(
    private val openRemote: (itemId: String) -> Boolean,
    private val profileNoted: (String) -> Unit = {},
) : CastRemote {
    override fun snapshot(): CastSnapshot? = CastHub.state.value

    override fun playPause() {
        val p = CastHub.link?.player ?: return
        if (p.playWhenReady) p.pause() else p.play()
    }

    override fun next() {
        val p = CastHub.link?.player ?: return
        if (p.hasNextMediaItem()) p.seekToNextMediaItem()
    }

    override fun stop() = CastHub.stop()

    override fun open(): Boolean = CastHub.state.value?.let { openRemote(it.itemId) } ?: false

    override fun sessionChanged(profileId: String?) {
        if (profileId == null) {
            CastHub.stop() // signed out: the cast ends
        } else {
            profileNoted(profileId)
            CastHub.noteProfile(profileId) // another profile than the cast's ends it
        }
    }
}
