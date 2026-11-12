// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import app.friendflix.android.bridge.CastRemote

/**
 * The web UI's handle on the app's cast ([CastHub]): reads the snapshot, drives the receiver's player and ends the cast.
 * Main thread only (the bridge's calls). [openRemote] starts the native player as the remote of the snapshot's item,
 * [profileNoted] hands a switched-to profile on (the offline list follows it too), [pickDevice] opens the device chooser for `castLive`.
 */
class HubCastRemote(
    private val openRemote: (itemId: String) -> Boolean,
    private val profileNoted: (String) -> Unit = {},
    /** shows the Cast device chooser (no TV connected yet); false when it could not be shown */
    private val pickDevice: () -> Boolean = { false },
) : CastRemote {
    override fun snapshot(): CastSnapshot? = CastHub.state.value

    override fun playPause() = CastHub.playPause()

    override fun next(): Boolean = CastHub.next()

    override fun stop() = CastHub.userStop()

    override fun open(): Boolean = CastHub.openTarget()?.let(openRemote) ?: false

    override fun castLive(channelId: String, done: (Boolean) -> Unit) = CastHub.castLive(channelId, pickDevice, done)

    override fun sessionChanged(profileId: String?, done: () -> Unit) {
        if (profileId == null) {
            CastHub.stopThen(done) // signed out: the cast ends, the answer waits for its stop report and revoke
        } else {
            profileNoted(profileId)
            CastHub.noteProfileThen(profileId, done) // another profile than the cast's ends it
        }
    }
}
