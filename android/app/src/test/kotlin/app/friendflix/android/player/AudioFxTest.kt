// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AudioFxTest {
    private val voicesEq = listOf(180f to -4f, 4000f to 6f, 20000f to -2f)
    private val voicesComp = Comp(-24f, 3f, 10f, 250f)
    private val nightComp = Comp(-42f, 8f, 4f, 300f)
    private val nightLimiter = Comp(-4f, 20f, 1f, 100f)

    @Test fun offIsNull() = assertNull(fxConfig("off"))

    @Test fun unknownModeIsNull() = assertNull(fxConfig("loud"))

    @Test fun voices() = assertEquals(FxParams(voicesEq, voicesComp, null, 1.94f), fxConfig("voices"))

    @Test fun night() = assertEquals(FxParams(emptyList(), nightComp, nightLimiter, 6.85f), fxConfig("night"))

    @Test fun both() = assertEquals(FxParams(voicesEq, nightComp, nightLimiter, 6.85f), fxConfig("both"))
}
