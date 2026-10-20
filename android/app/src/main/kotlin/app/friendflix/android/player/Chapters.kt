// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** web lib/player/chapters.ts `normalizeChapters`: sorted by start, one chapter per start, an image only when it is a root-relative URL. */
fun normaliseChapters(raw: List<Chapter>): List<Chapter> =
    raw.filter { it.startSec.isFinite() && it.startSec >= 0 }
        .map { it.copy(name = it.name.trim(), image = it.image?.takeIf { u -> u.startsWith("/") }) }
        .sortedBy { it.startSec }
        .distinctBy { it.startSec }
