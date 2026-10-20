// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** The link "Share from here" copies: the title's watch page at the current second. */
fun shareUrl(origin: String, itemId: String, positionMs: Long): String = "$origin/watch/$itemId?t=${positionMs / 1000}"

/** Playback speeds of the speed menu. */
val SPEEDS = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)
