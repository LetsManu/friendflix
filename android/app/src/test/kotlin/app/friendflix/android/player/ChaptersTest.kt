// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChaptersTest {
    @Test fun sortsAndDropsDuplicateStarts() {
        val out = normaliseChapters(listOf(Chapter(60.0, "B", null), Chapter(0.0, "A", null), Chapter(60.0, "dup", null)))
        assertEquals(listOf(0.0 to "A", 60.0 to "B"), out.map { it.startSec to it.name })
    }

    @Test fun keepsOnlyRootRelativeImages() {
        val out = normaliseChapters(listOf(Chapter(0.0, "A", "http://x"), Chapter(5.0, "B", "/img/b.jpg")))
        assertNull(out[0].image)
        assertEquals("/img/b.jpg", out[1].image)
    }
}
