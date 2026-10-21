// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Test

class PostPlayTimingTest {
    private val d = 1000.0

    @Test fun outroWins() =
        assertEquals(900.0, postplayAtSec(d, listOf(Segment("outro", 900.0, 1000.0)), listOf(Chapter(850.0, "", null))), 0.0)

    @Test fun lastChapterFromEightyPercent() =
        assertEquals(850.0, postplayAtSec(d, emptyList(), listOf(Chapter(0.0, "", null), Chapter(500.0, "", null), Chapter(850.0, "", null))), 0.0)

    @Test fun earlyLastChapterIgnored() =
        assertEquals(950.0, postplayAtSec(d, emptyList(), listOf(Chapter(0.0, "", null), Chapter(700.0, "", null))), 0.0)

    @Test fun fallbackIsNinetyFivePercent() = assertEquals(950.0, postplayAtSec(d, emptyList(), emptyList()), 0.0)

    @Test fun unknownDurationIsInfinite() = assertEquals(Double.POSITIVE_INFINITY, postplayAtSec(0.0, emptyList(), emptyList()), 0.0)

    @Test fun creditsFromOutroInSecondHalf() = assertEquals(900.0, creditsStartSec(d, listOf(Segment("outro", 900.0, 1000.0))), 0.0)

    @Test fun creditsEarlyOutroFallsBackToLast25s() = assertEquals(975.0, creditsStartSec(d, listOf(Segment("outro", 100.0, 200.0))), 0.0)

    @Test fun creditsWithoutOutro() = assertEquals(975.0, creditsStartSec(d, emptyList()), 0.0)
}
