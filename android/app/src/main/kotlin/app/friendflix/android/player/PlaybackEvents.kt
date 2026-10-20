// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import androidx.annotation.OptIn
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi

/**
 * Turns player events into progress reports (online [PlaybackReporter], offline [OfflineProgress]) with the web player's rules.
 *
 * ExoPlayer keeps `playWhenReady` true at the end of the title, so a replay from the end (PlayerView: seek to 0 + play) never
 * changes it; the replay is noticed when playback runs again ([onIsPlayingChanged]) while the reporter has ended its session,
 * and it starts a new one, like the web's `onPlay` after `ended`.
 */
class PlaybackEvents(
    private val reporter: () -> PlaybackReporter?,
    private val offline: () -> OfflineProgress?,
    /** play was asked for (any source: screen, notification, Bluetooth) */
    private val onPlayRequested: () -> Unit = {},
    private val onEnded: () -> Unit = {},
) : Player.Listener {
    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (playWhenReady) {
            onPlayRequested()
            reporter()?.onPlay()
        } else {
            reporter()?.onPause()
            offline()?.flush()
        }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (!isPlaying) return
        val r = reporter() ?: return
        if (r.ended) r.onPlay() // replay after the end: a new start
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState != Player.STATE_ENDED) return
        reporter()?.onEnded()
        offline()?.flush()
        onEnded()
    }

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        if (reason != Player.DISCONTINUITY_REASON_SEEK) return
        reporter()?.onSeeked()
        offline()?.flush()
    }
}

/**
 * The player as the media session sees it (notification, lock screen, Bluetooth / headset): a play command is ignored while
 * [mayPlay] says no (the player screen is in the background, not in picture-in-picture, and background audio is off).
 */
@OptIn(UnstableApi::class)
class GatedPlayer(player: Player, private val mayPlay: () -> Boolean) : ForwardingPlayer(player) {
    override fun play() { if (mayPlay()) super.play() }

    override fun setPlayWhenReady(playWhenReady: Boolean) {
        if (!playWhenReady || mayPlay()) super.setPlayWhenReady(playWhenReady)
    }
}
