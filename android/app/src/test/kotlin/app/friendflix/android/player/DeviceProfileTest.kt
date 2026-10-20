// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.media.MediaCodecInfo.CodecProfileLevel
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeviceProfileTest {
    private fun dec(name: String, mime: String, hw: Boolean?, maxHeight: Int? = 1080, profiles: Set<Int> = emptySet()) =
        Decoder(name, mime, hw, maxHeight, profiles)

    /** a typical emulator / budget phone: software decoders only (Android's own c2.android.* codecs) */
    private val softwareOnly = listOf(
        dec("c2.android.avc.decoder", "video/avc", false, 1080, setOf(CodecProfileLevel.AVCProfileMain, CodecProfileLevel.AVCProfileHigh)),
        dec("c2.android.hevc.decoder", "video/hevc", false, 1080, setOf(CodecProfileLevel.HEVCProfileMain, CodecProfileLevel.HEVCProfileMain10)),
        dec("c2.android.av1.decoder", "video/av01", false, 1080),
        dec("c2.android.vp9.decoder", "video/x-vnd.on2.vp9", false, 1080),
        dec("c2.android.aac.decoder", "audio/mp4a-latm", false, null),
        dec("c2.android.opus.decoder", "audio/opus", false, null),
    )

    @Test fun noHardwareHevcMeansNoHevc() {
        val caps = DeviceProfile.fromDecoders(softwareOnly, "2.0.0")
        val codecs = caps.video.map { it.codec }
        assertFalse("software HEVC must not be offered", "hevc" in codecs)
        assertFalse("software AV1 must not be offered", "av1" in codecs)
        assertTrue("h264 always", "h264" in codecs)
        assertTrue("vp9 may be software", "vp9" in codecs)
    }

    @Test fun hardwareHevcWithMain10IsOffered() {
        val list = softwareOnly + dec("c2.qti.hevc.decoder", "video/hevc", true, 2160, setOf(CodecProfileLevel.HEVCProfileMain, CodecProfileLevel.HEVCProfileMain10))
        val hevc = DeviceProfile.fromDecoders(list, "2.0.0").video.single { it.codec == "hevc" }
        assertEquals(2160, hevc.maxHeight)
        assertEquals(listOf("main", "main 10"), hevc.profiles)
    }

    @Test fun hardwareAv1IsOffered() {
        val list = softwareOnly + dec("c2.exynos.av1.decoder", "video/av01", true, 2160, setOf(CodecProfileLevel.AV1ProfileMain8))
        val av1 = DeviceProfile.fromDecoders(list, "2.0.0").video.single { it.codec == "av1" }
        assertEquals(listOf("main"), av1.profiles)
    }

    @Test fun nameHeuristicBeforeApi29() {
        assertFalse(DeviceProfile.isHardware("OMX.google.hevc.decoder", null))
        assertFalse(DeviceProfile.isHardware("c2.android.hevc.decoder", null))
        assertFalse(DeviceProfile.isHardware("OMX.ffmpeg.hevc.decoder", null))
        assertFalse(DeviceProfile.isHardware("c2.qti.hevc.decoder.sw", null))
        assertTrue(DeviceProfile.isHardware("OMX.qcom.video.decoder.hevc", null))
        assertTrue(DeviceProfile.isHardware("c2.exynos.hevc.decoder", null))
        // API 29+: the platform's own flag wins
        assertFalse(DeviceProfile.isHardware("OMX.qcom.video.decoder.hevc", false))
        assertTrue(DeviceProfile.isHardware("anything", true))
    }

    @Test fun oldDeviceHevcByName() {
        val list = listOf(dec("OMX.MTK.VIDEO.DECODER.HEVC", "video/hevc", null, 2160, setOf(CodecProfileLevel.HEVCProfileMain)))
        assertTrue("hevc" in DeviceProfile.fromDecoders(list, "2.0.0").video.map { it.codec })
    }

    @Test fun ac3OnlyWithADecoder() {
        assertFalse("ac3" in DeviceProfile.fromDecoders(softwareOnly, "2.0.0").audio)
        val list = softwareOnly + dec("c2.dolby.ac3.decoder", "audio/ac3", true, null) + dec("c2.dolby.eac3.decoder", "audio/eac3", true, null)
        val audio = DeviceProfile.fromDecoders(list, "2.0.0").audio
        assertTrue("ac3" in audio)
        assertTrue("eac3" in audio)
    }

    @Test fun alwaysCompleteListsWithMp4H264Aac() {
        // the server's lists REPLACE the browser defaults (Task 3): mp4 / h264 / aac must be there even with an empty codec list
        val caps = DeviceProfile.fromDecoders(emptyList(), "2.0.0")
        assertTrue("mp4" in caps.containers)
        assertTrue("h264" in caps.video.map { it.codec })
        assertTrue("aac" in caps.audio)
        assertTrue("vtt" in caps.subtitles)
        assertTrue("srt" in caps.subtitles)
    }

    @Test fun jsonHasExactlyTheServerKeys() {
        val list = softwareOnly + dec("c2.qti.hevc.decoder", "video/hevc", true, 2160, setOf(CodecProfileLevel.HEVCProfileMain))
        val j = DeviceProfile.fromDecoders(list, "2.0.0").toJson()
        assertEquals(setOf("client", "appVersion", "containers", "video", "audio", "subtitles"), j.keys().asSequence().toSet())
        assertEquals("android", j.getString("client"))
        assertEquals("2.0.0", j.getString("appVersion"))
        for (k in listOf("containers", "video", "audio", "subtitles")) assertTrue(k, j.getJSONArray(k).length() in 1..16)
        val v = j.getJSONArray("video")
        for (i in 0 until v.length()) {
            val o: JSONObject = v.getJSONObject(i)
            assertTrue(o.keys().asSequence().toSet().all { it in setOf("codec", "maxHeight", "profiles") })
            if (o.has("maxHeight")) assertTrue(o.getInt("maxHeight") in 1..8640)
            if (o.has("profiles")) {
                val p = o.getJSONArray("profiles")
                for (x in 0 until p.length()) assertTrue(p.getString(x).matches(Regex("[a-z0-9][a-z0-9 ._-]{0,31}")))
            }
        }
    }

    @Test fun appVersionIsStrictOrPlaceholder() {
        assertEquals("2.0.0", DeviceProfile.fromDecoders(emptyList(), "2.0.0").appVersion)
        assertEquals("2.0.0", DeviceProfile.fromDecoders(emptyList(), "2.0.0-debug").appVersion)
        assertEquals("0.0.0", DeviceProfile.fromDecoders(emptyList(), "dev").appVersion)
    }

    @Test fun unknownHeightIsLeftOut() {
        val list = listOf(dec("c2.android.avc.decoder", "video/avc", false, null))
        assertNull(DeviceProfile.fromDecoders(list, "2.0.0").video.single { it.codec == "h264" }.maxHeight)
    }
}
