// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import androidx.media3.common.PlaybackException
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SurroundTest {
    private val caps = ClientCaps("2.0.0", listOf("mp4"), emptyList(), listOf("aac"), listOf("vtt"))
    private val hevcSurround = Delivery("hevc", "hevc", "surround", "eac3", 6)
    private val h264Stereo = Delivery("h264", "h264", "stereo", "aac", 2)
    private val hevcOnly = Delivery("copy", "hevc", "stereo", "aac", 2)
    private val surroundOnly = Delivery("copy", "h264", "copy", "ac3", 6)

    private var clock = 1_000_000_000L

    private fun store(): SurroundStore {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val prefs = ctx.getSharedPreferences("surround_test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        return SurroundStore(prefs) { clock }
    }

    // ---- infoBody: fellBack / prevPs only on a fallback

    @Test fun infoBodyHasNoFallbackFieldsByDefault() {
        val b = PlayerApi.infoBody("ep1", null, null, null, manual = false, audioLang = null, caps = caps)
        assertFalse(b.has("fellBack"))
        assertFalse(b.has("prevPs"))
    }

    @Test fun infoBodyCarriesTheFallback() {
        val b = PlayerApi.infoBody("ep1", null, null, null, manual = false, audioLang = null, caps = caps, fellBack = "both", prevPs = "ps-1_a")
        assertEquals("both", b.getString("fellBack"))
        assertEquals("ps-1_a", b.getString("prevPs"))
    }

    @Test fun infoBodyDropsAnIncompleteOrUnknownFallback() {
        assertFalse(PlayerApi.infoBody("ep1", null, null, null, false, null, caps, fellBack = "hevc", prevPs = null).has("fellBack"))
        assertFalse(PlayerApi.infoBody("ep1", null, null, null, false, null, caps, fellBack = "dts", prevPs = "ps1").has("fellBack"))
        assertFalse(PlayerApi.infoBody("ep1", null, null, null, false, null, caps, fellBack = "hevc", prevPs = "a b").has("prevPs"))
    }

    // ---- the delivery block of /info

    @Test fun parsesTheDeliveryBlock() {
        val j = org.json.JSONObject(
            """{"playSessionId":"ps1","resumeTicks":0,"audioTracks":[],"subtitles":[],"hlsUrl":"/media/a.m3u8",
               "delivery":{"video":"copy","videoCodec":"hevc","audio":"surround","audioCodec":"eac3","channels":6,"why":["hevc_device"]}}""",
        )
        val d = PlayerApi.parseInfo(j)!!.delivery!!
        assertTrue(d.hevc)
        assertTrue(d.surround)
        assertEquals("eac3", d.audioCodec)
    }

    @Test fun noDeliveryBlockMeansNull() {
        val j = org.json.JSONObject("""{"playSessionId":"ps1","resumeTicks":0,"audioTracks":[],"subtitles":[],"hlsUrl":"/media/a.m3u8"}""")
        assertNull(PlayerApi.parseInfo(j)!!.delivery)
    }

    // ---- the one fallback

    @Test fun decoderErrorDropsWhatTheStreamHas() {
        val c = PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
        assertEquals("both", Fallback.feature(hevcSurround, false, false, c))
        assertEquals("hevc", Fallback.feature(hevcOnly, false, false, c))
        assertEquals("surround", Fallback.feature(surroundOnly, false, false, c))
        assertNull(Fallback.feature(h264Stereo, false, false, c))
    }

    @Test fun audioTrackErrorDropsSurroundOnly() {
        val c = PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED
        assertEquals("surround", Fallback.feature(hevcSurround, false, false, c))
        assertNull(Fallback.feature(hevcOnly, false, false, c))
    }

    @Test fun neverTwiceNeverDirectNeverOnNetworkErrors() {
        val c = PlaybackException.ERROR_CODE_DECODING_FAILED
        assertNull("one fallback per session", Fallback.feature(hevcSurround, false, true, c))
        assertNull("direct play has its own fallback", Fallback.feature(hevcSurround, true, false, c))
        assertNull("no plan from the server", Fallback.feature(null, false, false, c))
        assertNull(Fallback.feature(hevcSurround, false, false, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED))
        assertNull(Fallback.feature(hevcSurround, false, false, PlaybackException.ERROR_CODE_TIMEOUT))
    }

    // ---- the store: the switch and the 30 days

    @Test fun surroundIsOnUntilSwitchedOff() {
        val s = store()
        assertTrue(s.enabled)
        s.enabled = false
        assertFalse(s.enabled)
    }

    @Test fun aFallbackIsRememberedFor30DaysPerFeature() {
        val s = store()
        assertFalse(s.avoidsHevc())
        assertFalse(s.avoidsSurround())
        s.avoid("hevc")
        assertTrue(s.avoidsHevc())
        assertFalse(s.avoidsSurround())
        clock += SurroundStore.AVOID_MS - 1
        assertTrue(s.avoidsHevc())
        clock += 1
        assertFalse(s.avoidsHevc())
    }

    @Test fun bothMarksBothAndAClockGoingBackwardsForgets() {
        val s = store()
        s.avoid("both")
        assertTrue(s.avoidsHevc())
        assertTrue(s.avoidsSurround())
        clock -= 1
        assertFalse(s.avoidsHevc())
    }
}
