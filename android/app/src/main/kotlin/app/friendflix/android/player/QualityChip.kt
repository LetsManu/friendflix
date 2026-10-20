// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.view.View
import android.widget.TextView
import app.friendflix.android.R

/** The quality rungs a viewer can pick (web lib/player/abr.ts LADDER, finite rungs), highest first. */
val QUALITIES = listOf("1080p" to 8_000_000L, "720p" to 4_000_000L, "480p" to 1_500_000L, "360p" to 800_000L)

/**
 * The top bar's quality chip (web QualityChip.svelte): "Original" when the file plays directly, else "Converted · 720p"; a tap
 * explains it ([show] gets the text: direct playback, or the reason for the server's `transcodeReason`).
 */
class QualityChip(private val view: TextView, private val show: (String) -> Unit) {
    private var direct = false
    private var reason: String? = null
    /** a stream's quality was bound: the chip has something to say */
    private var bound = false

    init {
        view.setOnClickListener {
            show(view.context.getString(if (direct) R.string.player_quality_direct_info else reasonText(reason)))
        }
    }

    /**
     * [maxBitrate] = the stream's bit rate (its rung is shown); [reason] = the server's `transcodeReason`. Whether it shows is the
     * bar's rule ([show], from [PlayerControls.updateBar]).
     */
    fun bind(direct: Boolean, maxBitrate: Long, reason: String?) {
        this.direct = direct
        this.reason = reason
        bound = true
        view.text = if (direct) view.context.getString(R.string.player_quality_original) else view.context.getString(R.string.player_chip_converted, rungLabel(maxBitrate))
        view.contentDescription = view.context.getString(R.string.player_chip_label) + ": " + view.text
    }

    /** shown when the bar offers it ([BarState.chip]) and a stream was bound */
    fun show(on: Boolean) { view.visibility = if (on && bound) View.VISIBLE else View.GONE }

    fun hide() { view.visibility = View.GONE }

    companion object {
        /** the rung of a bit rate by threshold, like the server's rung height (web rungKey: a 20 Mbit/s transcode is 1080p) */
        fun rungLabel(bps: Long): String = QUALITIES.firstOrNull { bps >= it.second }?.first ?: QUALITIES.last().first

        fun reasonText(reason: String?): Int = when (reason) {
            "network" -> R.string.player_quality_reason_network
            "remoteCap" -> R.string.player_quality_reason_remote_cap
            "roleCap" -> R.string.player_quality_reason_role_cap
            "container" -> R.string.player_quality_reason_container
            "videoCodec" -> R.string.player_quality_reason_video_codec
            "audioCodec" -> R.string.player_quality_reason_audio_codec
            "audioTrack" -> R.string.player_quality_reason_audio_track
            "subtitles" -> R.string.player_quality_reason_subtitles
            "height" -> R.string.player_quality_reason_height
            "manual" -> R.string.player_quality_reason_manual
            else -> R.string.player_quality_reason_other
        }
    }
}
