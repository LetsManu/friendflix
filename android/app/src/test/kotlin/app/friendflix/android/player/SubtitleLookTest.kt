// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.graphics.Color
import android.graphics.Typeface
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SubtitleLookTest {
    private fun look(size: String = "m", color: String = "white", bg: String = "semi", font: String = "sans") =
        captionLook(SubtitleStyle(size, color, bg, font))

    @Test fun sizes() {
        val base = SubtitleView.DEFAULT_TEXT_SIZE_FRACTION
        assertEquals(base * .9f, look(size = "s").fractionalSize, 1e-6f)
        assertEquals(base * 1.15f, look(size = "m").fractionalSize, 1e-6f)
        assertEquals(base * 1.5f, look(size = "l").fractionalSize, 1e-6f)
        assertEquals(base * 1.9f, look(size = "xl").fractionalSize, 1e-6f)
    }

    @Test fun colours() {
        assertEquals(Color.parseColor("#FFFFFF"), look(color = "white").foreground)
        assertEquals(Color.parseColor("#FFE14D"), look(color = "yellow").foreground)
        assertEquals(Color.parseColor("#4DE8FF"), look(color = "cyan").foreground)
        assertEquals(Color.parseColor("#6DFF7A"), look(color = "green").foreground)
    }

    @Test fun backgrounds() {
        assertEquals(Color.TRANSPARENT, look(bg = "none").background)
        assertEquals(CaptionStyleCompat.EDGE_TYPE_NONE, look(bg = "none").edgeType)
        val shadow = look(bg = "shadow")
        assertEquals(Color.TRANSPARENT, shadow.background)
        assertEquals(CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, shadow.edgeType)
        assertEquals(Color.BLACK, shadow.edgeColor)
        assertEquals(Color.parseColor("#A6000000"), look(bg = "semi").background)
        assertEquals(Color.parseColor("#FF000000"), look(bg = "solid").background)
    }

    @Test fun fonts() {
        assertSame(Typeface.SANS_SERIF, look(font = "sans").typeface)
        assertSame(Typeface.SERIF, look(font = "serif").typeface)
        assertSame(Typeface.MONOSPACE, look(font = "mono").typeface)
    }

    @Test fun unknownValuesFallBackToDefaults() {
        val l = look("huge", "pink", "glow", "comic")
        assertEquals(look(), l)
    }
}
