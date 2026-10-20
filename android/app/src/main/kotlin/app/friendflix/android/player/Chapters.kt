// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** web lib/player/chapters.ts `normalizeChapters`: sorted by start, one chapter per start, an image only when it is a root-relative URL. */
fun normaliseChapters(raw: List<Chapter>): List<Chapter> =
    raw.filter { it.startSec.isFinite() && it.startSec >= 0 }
        .map { it.copy(name = it.name.trim(), image = it.image?.takeIf { u -> u.startsWith("/") }) }
        .sortedBy { it.startSec }
        .distinctBy { it.startSec }

/** The chapter playing at [t] s (the last one that started, 50 ms early like the web's `chapterIndexAt`); -1 before the first. */
fun chapterIndexAt(chapters: List<Chapter>, t: Double): Int {
    var i = -1
    for ((k, c) in chapters.withIndex()) if (c.startSec <= t + 0.05) i = k else break
    return i
}

/**
 * The seek bar's marks (ms, sorted, one per time): every chapter start after the first half second (one at 0 is just the bar's
 * left edge, web `chapterMarks`) and every bookmark.
 */
fun seekMarksMs(chapters: List<Chapter>, bookmarks: List<Bookmark>): LongArray =
    (chapters.filter { it.startSec > 0.5 }.map { (it.startSec * 1000).toLong() } + bookmarks.map { it.positionSec * 1000L })
        .distinct().sorted().toLongArray()
