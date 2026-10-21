// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

private const val LAST_CHAPTER_SHARE = 0.8
private const val END_SHARE = 0.95
private const val CREDITS_TAIL_SEC = 25.0

private fun isOutro(s: Segment) = s.type.lowercase().let { it == "outro" || it == "credits" }

/** Second the credits begin (Infinity while the duration is unknown): an outro in the second half, else the last 25 s. */
fun creditsStartSec(durationSec: Double, segments: List<Segment>): Double {
    if (durationSec <= 0) return Double.POSITIVE_INFINITY
    val seg = segments.filter { isOutro(it) && it.startSec > 0 && it.startSec < durationSec }.minByOrNull { it.startSec }
    return if (seg != null && seg.startSec >= durationSec / 2) seg.startSec else maxOf(0.0, durationSec - CREDITS_TAIL_SEC)
}

/** web lib/postplay.ts `postplayStart`: outro start, else the last chapter from 80 %, else 95 % of the duration. */
fun postplayAtSec(durationSec: Double, segments: List<Segment>, chapters: List<Chapter>): Double {
    if (durationSec <= 0) return Double.POSITIVE_INFINITY
    segments.filter { isOutro(it) && it.startSec >= durationSec / 2 && it.startSec < durationSec }.minByOrNull { it.startSec }?.let { return it.startSec }
    val last = chapters.filter { it.startSec > 0 && it.startSec < durationSec }.maxByOrNull { it.startSec }
    if (last != null && last.startSec >= durationSec * LAST_CHAPTER_SHARE) return last.startSec
    return durationSec * END_SHARE
}
