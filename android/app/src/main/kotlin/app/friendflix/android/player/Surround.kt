// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.core.content.edit
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities

/**
 * What the current audio output takes (spec §1 decision 8). [pcmChannels] is what the route takes as PCM (2 unless the speaker
 * layout of an HDMI / USB sink says more), [passthrough] the Dolby encodings it accepts (`eac3`, `ac3`), [maxChannels] the channels the
 * device may claim: [pcmChannels] when that is 6 or more, 6 when only passthrough proves 5.1, else 2. Built at every `/info` request
 * (the route changes with headphones, HDMI, Bluetooth), never cached. Media3's own `maxChannelCount` is NOT used: it is 10 on every
 * phone (the default PCM profile), so it proves nothing.
 */
data class AudioOut(val maxChannels: Int, val passthrough: Set<String>, val pcmChannels: Int = maxChannels) {
    companion object {
        /** speaker / headphones / unknown: nothing is claimed */
        val STEREO = AudioOut(2, emptySet())

        /** Media3's view of the current output; any failure counts as stereo (never claim before a positive check) */
        @androidx.annotation.OptIn(UnstableApi::class)
        fun current(context: Context): AudioOut = try {
            val caps = AudioCapabilities.getCapabilities(context.applicationContext, AudioAttributes.DEFAULT, null, emptyList())
            val pass = buildSet {
                if (caps.supportsEncoding(C.ENCODING_E_AC3)) add("eac3")
                if (caps.supportsEncoding(C.ENCODING_AC3)) add("ac3")
            }
            // speaker layouts exist for HDMI / USB sinks (API 33+); headphones, Bluetooth and everything else give none: stereo
            val pcm = caps.speakerLayoutChannelMasks.maxOfOrNull { Integer.bitCount(it) }?.coerceAtLeast(2) ?: 2
            of(pcm, pass)
        } catch (_: RuntimeException) {
            STEREO
        }

        /** the claim for [pcm] PCM channels and [passthrough] encodings (pure, for tests) */
        fun of(pcm: Int, passthrough: Set<String>): AudioOut =
            AudioOut(if (pcm >= 6) pcm else if (passthrough.isNotEmpty()) 6 else 2, passthrough, pcm)
    }
}

/**
 * Device-wide choices of the HLS claims: the *Surround sound* switch (default on) and the one-time fallback memory (spec §9):
 * after a failed start with HEVC or surround the device leaves that feature out for 30 days.
 */
class SurroundStore(
    private val prefs: SharedPreferences,
    private val now: () -> Long = System::currentTimeMillis,
    /** the system build: a remembered failure is forgotten after an OS update (web: a user-agent change) */
    private val build: String = Build.FINGERPRINT.orEmpty(),
) {
    var enabled: Boolean
        get() = prefs.getBoolean(ENABLED, true)
        set(v) = prefs.edit { putBoolean(ENABLED, v) }

    /** [feature] = `hevc | surround | both` */
    fun avoid(feature: String) {
        val t = now()
        prefs.edit {
            putString(BUILD, build)
            if (feature == "hevc" || feature == "both") putLong(HEVC_AT, t)
            if (feature == "surround" || feature == "both") putLong(SURROUND_AT, t)
        }
    }

    fun avoidsHevc(): Boolean = recent(prefs.getLong(HEVC_AT, 0L))
    fun avoidsSurround(): Boolean = recent(prefs.getLong(SURROUND_AT, 0L))

    private fun recent(at: Long): Boolean = prefs.getString(BUILD, null) == build && at > 0L && now() - at in 0 until AVOID_MS

    companion object {
        private const val FILE = "player_surround"
        private const val ENABLED = "enabled"
        private const val BUILD = "avoid_build"
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
     * [mime] is the sample MIME type of the failing renderer's format when ExoPlayer names it: an audio one drops surround only, a
     * video one HEVC only (an H.264 error drops nothing). Without it an audio track error names surround only and any other decoder
     * error drops everything the stream carried.
     */
    fun feature(d: Delivery?, direct: Boolean, avoided: Boolean, code: Int, mime: String? = null): String? {
        if (d == null || direct || avoided) return null
        return when {
            code in AUDIO_CODES -> if (d.surround) "surround" else null
            code in VIDEO_CODES && mime != null && mime.startsWith("audio/") -> if (d.surround) "surround" else null
            code in VIDEO_CODES && mime != null && mime.startsWith("video/") -> if (d.hevc) "hevc" else null
            code in VIDEO_CODES && mime != null -> null // a subtitle or other track: nothing to drop
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
