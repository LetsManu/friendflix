// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Test

class SceneTest {
    @Test fun shareUrlTruncatesToSeconds() =
        assertEquals("https://friend.example.com/watch/abc?t=754", shareUrl("https://friend.example.com", "abc", 754_900))

    @Test fun speeds() = assertEquals(listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f), SPEEDS)
}
