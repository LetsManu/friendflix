// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Locale

@RunWith(RobolectricTestRunner::class)
class TitleLangsTest {
    private val caps = ClientCaps("2.0.0", listOf("mp4"), emptyList(), listOf("aac"), listOf("vtt"))
    private val anime = PlayerPrefs(animeOriginal = true, audioLang = "ger", subtitleLang = "eng")

    private fun info(audio: List<AudioTrack>, subs: List<SubtitleTrack>, audioIndex: Int? = null) =
        PlaybackInfo("ps", "ms", null, "/hls", 0, 0, null, audioIndex, null, audio, subs)

    private val jpnDefault = listOf(AudioTrack(1, "Japanese", "jpn", true), AudioTrack(2, "German", "ger", false))
    private val gerDefault = listOf(AudioTrack(1, "German", "ger", true), AudioTrack(2, "Japanese", "jpn", false))
    private val subs = listOf(
        SubtitleTrack(5, "English", "eng", "/s5.vtt", false),
        SubtitleTrack(6, "Deutsch", "deu", "/s6.vtt", false),
    )

    @Test fun animeDefaultAsksForJapaneseInTheFirstInfoBody() {
        val l = TitleLangs(anime, LangPref(null, null, anime = true), appLang = "eng", wantAudio = null, wantSub = null)
        val body = PlayerApi.infoBody("ep1", null, null, null, manual = false, audioLang = l.audioLang(), caps = caps)
        assertEquals("jpn", body.getString("audioLang"))
    }

    @Test fun noAnimeDefaultWhenTheSeriesHasAChoiceOrTheProfileDoesNotWantIt() {
        // the series' choice wins over everything but the detail page
        assertEquals("eng", TitleLangs(anime, LangPref("eng", null, anime = true), "eng", null, null).audioLang())
        assertEquals("ger", TitleLangs(anime.copy(animeOriginal = false), LangPref(null, null, anime = true), "eng", null, null).audioLang())
        assertEquals("ger", TitleLangs(anime, LangPref(null, null, anime = false), "eng", null, null).audioLang())
        assertEquals("fre", TitleLangs(anime, LangPref(null, null, anime = true), "eng", wantAudio = "fre", wantSub = null).audioLang())
    }

    @Test fun animeSubtitleInTheAppLanguageWhileTheAudioIsJapanese() {
        val l = TitleLangs(anime, LangPref(null, null, anime = true), appLang = "ger", wantAudio = null, wantSub = null)
        assertEquals(6, l.subtitle(info(jpnDefault, subs))) // "deu" counts as German
        assertEquals(5, l.subtitle(info(gerDefault, subs))) // a dub plays: the profile default
        assertEquals(6, l.subtitle(info(gerDefault, subs, audioIndex = 2))) // the server baked the Japanese track in
        val en = TitleLangs(anime, LangPref(null, null, anime = true), appLang = "eng", wantAudio = null, wantSub = null)
        assertEquals(5, en.subtitle(info(jpnDefault, subs)))
    }

    @Test fun subtitleOrderIsDetailPickThenSeriesThenProfile() {
        val p = PlayerPrefs(subtitleLang = "eng")
        assertEquals(6, TitleLangs(p, LangPref(null, null, false), "eng", null, wantSub = "deu").subtitle(info(gerDefault, subs)))
        assertNull(TitleLangs(p, LangPref(null, null, false), "eng", null, wantSub = "off").subtitle(info(gerDefault, subs)))
        assertNull(TitleLangs(p, LangPref(null, "off", false), "eng", null, null).subtitle(info(gerDefault, subs)))
        assertEquals(6, TitleLangs(p, LangPref(null, "deu", false), "eng", null, null).subtitle(info(gerDefault, subs)))
        assertEquals(5, TitleLangs(p, LangPref(null, "spa", false), "eng", null, null).subtitle(info(gerDefault, subs)))
        assertNull(TitleLangs(PlayerPrefs(), LangPref(null, null, false), "eng", null, null).subtitle(info(gerDefault, subs)))
    }

    @Test fun appLanguageAsTrackCode() {
        assertEquals("ger", TitleLangs.appLang(Locale.GERMAN))
        assertEquals("ger", TitleLangs.appLang(Locale.forLanguageTag("de-AT")))
        assertEquals("eng", TitleLangs.appLang(Locale.ENGLISH))
        assertEquals("eng", TitleLangs.appLang(Locale.FRENCH))
    }
}
