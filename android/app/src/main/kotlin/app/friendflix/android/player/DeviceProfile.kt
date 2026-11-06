// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.os.Build
import app.friendflix.android.BuildConfig
import org.json.JSONArray
import org.json.JSONObject

/** One video codec the device can direct-play, as the server's caps block wants it (Task 3: `{codec, maxHeight?, profiles?}`). */
data class VideoCap(val codec: String, val maxHeight: Int? = null, val profiles: List<String> = emptyList())

/**
 * The capability block of `POST /api/playback/info` (`caps`, backend/src/media/clientCaps.ts). The server's lists REPLACE its browser
 * defaults, so every list is complete (mp4 / h264 / aac are always in). At most 16 entries per list (more invalidates the block).
 */
data class ClientCaps(
    val appVersion: String,
    val containers: List<String>,
    val video: List<VideoCap>,
    val audio: List<String>,
    val subtitles: List<String>,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("client", "android")
        .put("appVersion", appVersion)
        .put("containers", JSONArray(containers.take(MAX)))
        .put(
            "video",
            JSONArray(
                video.take(MAX).map { v ->
                    JSONObject().put("codec", v.codec).also { o ->
                        v.maxHeight?.let { o.put("maxHeight", it) }
                        if (v.profiles.isNotEmpty()) o.put("profiles", JSONArray(v.profiles.take(MAX)))
                    }
                },
            ),
        )
        .put("audio", JSONArray(audio.take(MAX)))
        .put("subtitles", JSONArray(subtitles.take(MAX)))

    companion object {
        const val MAX = 16
    }
}

/**
 * One decoder for one MIME type as the platform lists it. [hardware] is `MediaCodecInfo.isHardwareAccelerated` (API 29+) or null on
 * older systems (then the name decides, [DeviceProfile.isHardware]); [maxHeight] the largest 16:9 height it decodes (null = unknown);
 * [profiles] the `CodecProfileLevel` profile constants it reports.
 */
data class Decoder(val name: String, val mime: String, val hardware: Boolean?, val maxHeight: Int?, val profiles: Set<Int>)

/**
 * What this device can direct-play (spec §7): containers ExoPlayer extracts itself; H.264 always; HEVC and AV1 only with a hardware
 * decoder (software HEVC/AV1 on a phone stutters and drains the battery; the server transcodes instead); VP8/VP9/MPEG-4/MPEG-2 when any
 * decoder exists; AAC/MP3/Opus/FLAC/Vorbis always (platform decoders every Android has), AC3/E-AC3/DTS/TrueHD/ALAC only when a decoder
 * exists; text subtitle formats ExoPlayer renders. Role caps still apply on the server and win.
 */
object DeviceProfile {
    private val CONTAINERS = listOf("mp4", "m4v", "mkv", "webm", "mov", "ts")
    private val SUBTITLES = listOf("vtt", "srt", "subrip", "ass", "ssa")
    private val BASE_AUDIO = listOf("aac", "mp3", "opus", "flac", "vorbis")
    private val OPTIONAL_AUDIO = listOf("audio/ac3" to "ac3", "audio/eac3" to "eac3", "audio/eac3-joc" to "eac3", "audio/vnd.dts" to "dts", "audio/true-hd" to "truehd", "audio/alac" to "alac")
    private val HEIGHTS = listOf(4320, 2160, 1440, 1080, 720, 576, 480)
    private val H264_BASE = listOf("baseline", "constrained baseline", "main", "high")
    // CodecProfileLevel values (spelled out: several constants are newer than minSdk and would be inlined anyway)
    private const val HEVC_MAIN10 = 0x2
    private const val HEVC_MAIN10_HDR10 = 0x1000
    private const val HEVC_MAIN10_HDR10_PLUS = 0x2000
    private const val AV1_MAIN10 = 0x2
    private const val AV1_MAIN10_HDR10 = 0x1000
    private const val AV1_MAIN10_HDR10_PLUS = 0x2000

    /** The device's caps (reads MediaCodecList; call it off the main thread). The context is not needed by the platform list. */
    @Suppress("UNUSED_PARAMETER")
    fun build(context: Context): ClientCaps = fromDecoders(systemDecoders(), BuildConfig.VERSION_NAME)

    fun fromDecoders(decoders: List<Decoder>, versionName: String): ClientCaps {
        fun any(mime: String) = decoders.filter { it.mime.equals(mime, ignoreCase = true) }
        fun hw(mime: String) = any(mime).filter { isHardware(it.name, it.hardware) }
        fun height(ds: List<Decoder>): Int? = ds.mapNotNull { it.maxHeight }.maxOrNull()

        val video = mutableListOf<VideoCap>()
        val avc = any("video/avc")
        val avcProfiles = avc.flatMap { it.profiles }.toSet()
        video += VideoCap("h264", height(avc), H264_BASE + (if (CodecProfileLevel.AVCProfileHigh10 in avcProfiles) listOf("high 10") else emptyList()))
        hw("video/hevc").takeIf { it.isNotEmpty() }?.let { ds ->
            val p = ds.flatMap { it.profiles }.toSet()
            val tenBit = setOf(HEVC_MAIN10, HEVC_MAIN10_HDR10, HEVC_MAIN10_HDR10_PLUS)
            video += VideoCap("hevc", height(ds), listOf("main") + (if (p.any { it in tenBit }) listOf("main 10") else emptyList()))
        }
        hw("video/av01").takeIf { it.isNotEmpty() }?.let { ds ->
            val p = ds.flatMap { it.profiles }.toSet()
            val tenBit = setOf(AV1_MAIN10, AV1_MAIN10_HDR10, AV1_MAIN10_HDR10_PLUS)
            video += VideoCap("av1", height(ds), listOf("main") + (if (p.any { it in tenBit }) listOf("main 10") else emptyList()))
        }
        any("video/x-vnd.on2.vp9").takeIf { it.isNotEmpty() }?.let { video += VideoCap("vp9", height(it)) }
        any("video/x-vnd.on2.vp8").takeIf { it.isNotEmpty() }?.let { video += VideoCap("vp8", height(it)) }
        any("video/mp4v-es").takeIf { it.isNotEmpty() }?.let { video += VideoCap("mpeg4", height(it)) }
        any("video/mpeg2").takeIf { it.isNotEmpty() }?.let { video += VideoCap("mpeg2video", height(it)) }

        val audio = (BASE_AUDIO + OPTIONAL_AUDIO.filter { (mime, _) -> any(mime).isNotEmpty() }.map { it.second }).distinct()
        return ClientCaps(strictVersion(versionName), CONTAINERS, video, audio, SUBTITLES)
    }

    /**
     * Hardware decoder? API 29+: the platform's flag. Older: by name; Android's own software codecs (`OMX.google.*`, `c2.android.*`,
     * `c2.google.*`), FFmpeg-based ones and names marking a software variant are software, vendor codecs are hardware.
     */
    fun isHardware(name: String, platformFlag: Boolean?): Boolean {
        if (platformFlag != null) return platformFlag
        val n = name.lowercase()
        if (n.startsWith("omx.google.") || n.startsWith("c2.android.") || n.startsWith("c2.google.")) return false
        if ("ffmpeg" in n || "avcodec" in n || n.endsWith(".sw") || ".sw." in n || "software" in n) return false
        return true
    }

    /** `x.y.z` as the server requires; a suffix (`2.0.0-debug`) is cut, anything else is `0.0.0` (the server ignores invalid blocks). */
    private fun strictVersion(v: String): String = Regex("^(\\d{1,4})\\.(\\d{1,4})\\.(\\d{1,4})").find(v)?.value ?: "0.0.0"

    private fun systemDecoders(): List<Decoder> {
        val out = mutableListOf<Decoder>()
        for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
            if (info.isEncoder) continue
            val hw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.isHardwareAccelerated else null
            for (mime in info.supportedTypes) {
                val caps = try { info.getCapabilitiesForType(mime) } catch (_: IllegalArgumentException) { continue }
                out += Decoder(info.name, mime, hw, maxHeight(caps), caps.profileLevels.map { it.profile }.toSet())
            }
        }
        return out
    }

    private fun maxHeight(caps: MediaCodecInfo.CodecCapabilities): Int? {
        val v = caps.videoCapabilities ?: return null
        return HEIGHTS.firstOrNull { h -> runCatching { v.isSizeSupported(((h * 16 / 9) + 1) / 2 * 2, h) }.getOrDefault(false) }
    }
}
