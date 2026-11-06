// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** The link "Share from here" copies: the title's watch page at the current second. */
fun shareUrl(origin: String, itemId: String, positionMs: Long): String = "$origin/watch/$itemId?t=${positionMs / 1000}"

/** Playback speeds of the speed menu. */
val SPEEDS = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)

/** A position as m:ss, or h:mm:ss from an hour (web fmtClock: whole seconds, rounded down). */
fun timeLabel(seconds: Long): String {
    val s = maxOf(0L, seconds)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) String.format(java.util.Locale.ROOT, "%d:%02d:%02d", h, m, sec) else String.format(java.util.Locale.ROOT, "%d:%02d", m, sec)
}
