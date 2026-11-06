// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import android.media.audiofx.DynamicsProcessing
import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AudioFxAttachTest {
    /** every effect the attach opened: (session, config, released) */
    private class Opened(val session: Int, val config: DynamicsProcessing.Config) { var released = false }
    private val opened = mutableListOf<Opened>()
    private fun attach(sdk: Int = 34) = AudioFxAttach(sdk) { session, cfg -> Opened(session, cfg).also { opened += it }.let { o -> { o.released = true } } }

    @Test fun supportedFromAndroid9() {
        assertFalse(AudioFxAttach(26).supported())
        assertFalse(AudioFxAttach(27).supported())
        assertTrue(AudioFxAttach(28).supported())
    }

    @Test fun nightConfigHasTheWebValues() {
        val c = AudioFxAttach.config("night")!!
        val mbc = c.getMbcBandByChannelIndex(0, 0)
        assertEquals(-42f, mbc.threshold)
        assertEquals(8f, mbc.ratio)
        assertEquals(4f, mbc.attackTime)
        assertEquals(300f, mbc.releaseTime)
        assertEquals(18f, mbc.kneeWidth)
        val lim = c.getLimiterByChannelIndex(0)
        assertTrue(lim.isInUse)
        assertEquals(-4f, lim.threshold)
        assertEquals(20f, lim.ratio)
        assertEquals(1f, lim.attackTime)
        assertEquals(100f, lim.releaseTime)
        assertEquals(6.85f, c.getInputGainByChannelIndex(0))
        assertFalse(c.isPreEqInUse)
        assertTrue(c.isMbcInUse)
        assertEquals(1, c.mbcBandCount)
    }

    @Test fun voicesConfigHasThePreEqAndNoLimiter() {
        val c = AudioFxAttach.config("voices")!!
        assertTrue(c.isPreEqInUse)
        assertEquals(3, c.preEqBandCount)
        val bands = (0 until 3).map { c.getPreEqBandByChannelIndex(1, it).let { b -> b.cutoffFrequency to b.gain } }
        assertEquals(listOf(180f to -4f, 4000f to 6f, 20000f to -2f), bands)
        val mbc = c.getMbcBandByChannelIndex(1, 0)
        assertEquals(-24f, mbc.threshold)
        assertEquals(3f, mbc.ratio)
        assertEquals(12f, mbc.kneeWidth)
        assertFalse(c.isLimiterInUse)
        assertEquals(1.94f, c.getInputGainByChannelIndex(1))
    }

    @Test fun bothIsVoicesEqWithTheNightCompressor() {
        val c = AudioFxAttach.config("both")!!
        assertTrue(c.isPreEqInUse)
        assertEquals(-42f, c.getMbcBandByChannelIndex(0, 0).threshold)
        assertTrue(c.isLimiterInUse)
    }

    @Test fun offHasNoConfig() = assertNull(AudioFxAttach.config("off"))

    @Test fun applyOpensOnTheSessionAndReleasesTheOldOne() {
        val a = attach()
        a.apply(42, "night")
        assertEquals(1, opened.size)
        assertEquals(42, opened[0].session)
        assertEquals(-4f, opened[0].config.getLimiterByChannelIndex(0).threshold)
        a.apply(42, "night") // unchanged: nothing reopened
        assertEquals(1, opened.size)
        a.apply(42, "voices")
        assertTrue(opened[0].released)
        assertEquals(2, opened.size)
        a.apply(43, "voices") // a new audio session
        assertTrue(opened[1].released)
        assertEquals(43, opened[2].session)
        a.apply(43, "off")
        assertTrue(opened[2].released)
        assertEquals(3, opened.size)
        a.apply(43, "both")
        a.release()
        assertTrue(opened.all { it.released })
    }

    @Test fun applyDoesNothingBelowAndroid9OrWithoutASession() {
        attach(sdk = 26).apply(42, "night")
        attach().apply(0, "night")
        assertTrue(opened.isEmpty())
    }

    @Test fun anEffectTheDeviceRefusesKeepsPlaybackGoing() {
        val a = AudioFxAttach(34) { _, _ -> throw UnsupportedOperationException("no effect") }
        a.apply(42, "night") // no crash
        a.release()
    }

    /** an effect created but refused when switched on is released right away (no leaked DynamicsProcessing) */
    @Test fun anEffectThatCannotBeSwitchedOnIsReleased() {
        val released = mutableListOf<String>()
        try {
            AudioFxAttach.started("dp", { throw IllegalStateException("enable") }, { released += it })
            throw AssertionError("the enable error is passed on")
        } catch (_: IllegalStateException) { }
        assertEquals(listOf("dp"), released)
        val release = AudioFxAttach.started("dp2", {}, { released += it })
        assertEquals(listOf("dp"), released) // switched on: released only when asked
        release()
        assertEquals(listOf("dp", "dp2"), released)
    }

    @Test fun lastModeIsKeptPerProfile() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        assertEquals("off", FxStore.load(ctx, "p1"))
        FxStore.save(ctx, "p1", "night")
        FxStore.save(ctx, "p2", "voices")
        assertEquals("night", FxStore.load(ctx, "p1"))
        assertEquals("voices", FxStore.load(ctx, "p2"))
        FxStore.save(ctx, "p1", "loud") // unknown modes are not kept
        assertEquals("night", FxStore.load(ctx, "p1"))
    }

    @Test fun toggleToastNamesTheSwitchThatChanged() {
        assertEquals(R.string.player_fx_voices to true, fxToggle("off", "voices"))
        assertEquals(R.string.player_fx_night to true, fxToggle("voices", "both"))
        assertEquals(R.string.player_fx_voices to false, fxToggle("both", "night"))
        assertEquals(R.string.player_fx_night to false, fxToggle("night", "off"))
        assertNull(fxToggle("night", "night"))
    }

    @Test fun disabledReason() {
        assertEquals(R.string.player_fx_unsupported, fxDisabledReason(supported = false, casting = false))
        assertEquals(R.string.player_fx_casting, fxDisabledReason(supported = true, casting = true))
        assertNull(fxDisabledReason(supported = true, casting = false))
        assertNotNull(fxDisabledReason(supported = false, casting = true))
    }
}
