// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** One thumbnail's rectangle inside a trickplay sheet (px). */
data class Frame(val sheet: Int, val x: Int, val y: Int, val width: Int, val height: Int)

/** The thumbnail for [positionMs] (web lib/player/chapters.ts `trickFrame`): index = position / interval, clamped to the last one. */
fun trickplayFrame(t: TrickplayInfo, positionMs: Long): Frame {
    val last = maxOf(0, t.count - 1)
    val idx = (maxOf(0L, positionMs) / maxOf(1L, t.intervalMs)).coerceAtMost(last.toLong()).toInt()
    val per = maxOf(1, t.tileWidth * t.tileHeight)
    val within = idx % per
    val cols = maxOf(1, t.tileWidth)
    return Frame(idx / per, (within % cols) * t.width, (within / cols) * t.height, t.width, t.height)
}

/** The sheet's image URL (`{n}` = sheet index). */
fun sheetUrl(t: TrickplayInfo, sheet: Int): String = t.url.replace("{n}", sheet.toString())
