// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Test

class TrickplayTest {
    private val t = TrickplayInfo(320, 180, 10, 10, 250, 10_000, "/api/trick/{n}.jpg")

    @Test fun startIsFirstTileOfSheetZero() = assertEquals(Frame(0, 0, 0, 320, 180), trickplayFrame(t, 0))

    @Test fun lastTileOfSheetZeroAndFirstOfSheetOne() {
        assertEquals(Frame(0, 9 * 320, 9 * 180, 320, 180), trickplayFrame(t, 99 * 10_000L))
        assertEquals(Frame(1, 0, 0, 320, 180), trickplayFrame(t, 100 * 10_000L))
    }

    @Test fun rowsWrapWithinASheet() = assertEquals(Frame(0, 320, 180, 320, 180), trickplayFrame(t, 11 * 10_000L + 5))

    @Test fun beyondCountClampsToLastFrame() {
        assertEquals(Frame(2, 9 * 320, 4 * 180, 320, 180), trickplayFrame(t, 9_999_999_000L))
        assertEquals(trickplayFrame(t, 249 * 10_000L), trickplayFrame(t, 400 * 10_000L))
    }

    @Test fun negativePositionClampsToStart() = assertEquals(Frame(0, 0, 0, 320, 180), trickplayFrame(t, -5))

    @Test fun sheetUrlReplacesPlaceholder() = assertEquals("/api/trick/2.jpg", sheetUrl(t, 2))
}
