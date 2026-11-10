// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities

/**
 * What the current audio output takes (spec §1 decision 8): the largest channel count and the encodings it accepts as passthrough
 * (`eac3`, `ac3`). Built at every `/info` request (the route changes with headphones, HDMI, Bluetooth), never cached.
 */
data class AudioOut(val maxChannels: Int, val passthrough: Set<String>) {
    companion object {
        /** speaker / headphones / unknown: nothing is claimed */
        val STEREO = AudioOut(2, emptySet())

        /** Media3's view of the current output; any failure counts as stereo (never claim before a positive check) */
        @androidx.annotation.OptIn(UnstableApi::class)
        fun current(context: Context): AudioOut = try {
            val caps = AudioCapabilities.getCapabilities(context.applicationContext, AudioAttributes.DEFAULT, null)
            AudioOut(
                caps.maxChannelCount,
                buildSet {
                    if (caps.supportsEncoding(C.ENCODING_E_AC3)) add("eac3")
                    if (caps.supportsEncoding(C.ENCODING_AC3)) add("ac3")
                },
            )
        } catch (_: RuntimeException) {
            STEREO
        }
    }
}

/**
 * Device-wide choices of the HLS claims: the *Surround sound* switch (default on) and the one-time fallback memory (spec §9):
 * after a failed start with HEVC or surround the device leaves that feature out for 30 days.
 */
class SurroundStore(private val prefs: SharedPreferences, private val now: () -> Long = System::currentTimeMillis) {
    var enabled: Boolean
        get() = prefs.getBoolean(ENABLED, true)
        set(v) = prefs.edit { putBoolean(ENABLED, v) }

    /** [feature] = `hevc | surround | both` */
    fun avoid(feature: String) {
        val t = now()
        prefs.edit {
            if (feature == "hevc" || feature == "both") putLong(HEVC_AT, t)
            if (feature == "surround" || feature == "both") putLong(SURROUND_AT, t)
        }
    }

    fun avoidsHevc(): Boolean = recent(prefs.getLong(HEVC_AT, 0L))
    fun avoidsSurround(): Boolean = recent(prefs.getLong(SURROUND_AT, 0L))

    private fun recent(at: Long): Boolean = at > 0L && now() - at in 0 until AVOID_MS

    companion object {
        private const val FILE = "player_surround"
        private const val ENABLED = "enabled"
        private const val HEVC_AT = "avoid_hevc_at"
        private const val SURROUND_AT = "avoid_surround_at"
        const val AVOID_MS = 30L * 24 * 60 * 60 * 1000

        fun of(ctx: Context) = SurroundStore(ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE))
    }
}

/** What the server's `delivery` block says about an HLS stream (`PlaybackDto.delivery`): fixed codes only. */
data class Delivery(val video: String, val videoCodec: String, val audio: String, val audioCodec: String, val channels: Int) {
    val hevc: Boolean get() = videoCodec == "hevc"
    val surround: Boolean get() = channels > 2
}

/** The one automatic fallback (spec §9): which feature to leave out after a decoder or format error, or null when none applies. */
object Fallback {
    private val VIDEO_CODES = setOf(
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
    )
    private val AUDIO_CODES = setOf(
        PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED,
        PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED,
    )

    /**
     * `hevc | surround | both` for an error [code] of an HLS stream with [d]; null when the stream is direct, nothing has HEVC or
     * surround in it, a fallback happened already in this session ([avoided]) or the error is not a decoder / format one.
     * An audio track error names surround only; the others cannot say which track failed, so both features go.
     */
    fun feature(d: Delivery?, direct: Boolean, avoided: Boolean, code: Int): String? {
        if (d == null || direct || avoided) return null
        return when {
            code in AUDIO_CODES -> if (d.surround) "surround" else null
            code in VIDEO_CODES -> when {
                d.hevc && d.surround -> "both"
                d.hevc -> "hevc"
                d.surround -> "surround"
                else -> null
            }
            else -> null
        }
    }
}
