// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.graphics.Color
import android.graphics.Typeface
import androidx.annotation.OptIn
import androidx.core.graphics.toColorInt
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView

/** The native subtitle look of a profile's [SubtitleStyle] (web Player.svelte subtitle CSS). */
data class CaptionLook(
    val foreground: Int,
    val background: Int,
    val edgeType: Int,
    val edgeColor: Int,
    val typeface: Typeface,
    val fractionalSize: Float,
)

@OptIn(UnstableApi::class)
fun captionLook(s: SubtitleStyle): CaptionLook {
    val size = when (s.size) {
        "s" -> .9f
        "l" -> 1.5f
        "xl" -> 1.9f
        else -> 1.15f
    }
    val fg = when (s.color) {
        "yellow" -> "#FFE14D"
        "cyan" -> "#4DE8FF"
        "green" -> "#6DFF7A"
        else -> "#FFFFFF"
    }
    var edge = CaptionStyleCompat.EDGE_TYPE_NONE
    val bg = when (s.background) {
        "none" -> Color.TRANSPARENT
        "shadow" -> { edge = CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW; Color.TRANSPARENT }
        "solid" -> "#FF000000".toColorInt()
        else -> "#A6000000".toColorInt()
    }
    val face = when (s.font) {
        "serif" -> Typeface.SERIF
        "mono" -> Typeface.MONOSPACE
        else -> Typeface.SANS_SERIF
    }
    return CaptionLook(fg.toColorInt(), bg, edge, Color.BLACK, face, size * SubtitleView.DEFAULT_TEXT_SIZE_FRACTION)
}
