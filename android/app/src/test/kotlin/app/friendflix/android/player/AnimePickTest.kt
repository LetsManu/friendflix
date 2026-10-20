// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AnimePickTest {
    private val none = LangPref(null, null, true)

    @Test fun japaneseAudioGetsAppLanguageSubtitle() = assertEquals(AnimeChoice("jpn", "ger"), animeChoice(none, true, "ger", true))

    @Test fun nonJapaneseAudioGetsNoSubtitle() = assertEquals(AnimeChoice("jpn", null), animeChoice(none, true, "ger", false))

    @Test fun profileOptionOffMeansNoChoice() = assertNull(animeChoice(none, false, "ger", true))

    @Test fun notAnimeMeansNoChoice() = assertNull(animeChoice(LangPref(null, null, false), true, "ger", true))

    @Test fun seriesPrefWins() {
        assertNull(animeChoice(LangPref("eng", null, true), true, "ger", true))
        assertNull(animeChoice(LangPref(null, "eng", true), true, "ger", true))
    }
}
