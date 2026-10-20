// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import java.util.Locale

/**
 * The audio and subtitle language a title starts with (web Player.svelte `load` / `attach`, lib/player/anime.ts):
 * the detail page's pick ([wantAudio], [wantSub]; "off" = no subtitles) > the series' saved choice ([pref]) > the anime default
 * (Japanese audio, subtitles in [appLang] while the audio is Japanese) > the profile defaults ([prefs]).
 */
class TitleLangs(
    private val prefs: PlayerPrefs,
    private val pref: LangPref,
    private val appLang: String,
    private val wantAudio: String?,
    private val wantSub: String?,
) {
    /** the anime default applies to this title (anime series, profile wants it, no own choice yet) */
    val anime: Boolean = animeChoice(pref, prefs.animeOriginal, appLang, audioIsJapanese = false) != null

    /** the `audioLang` of the first `POST /api/playback/info`, or null */
    fun audioLang(): String? = (wantAudio ?: pref.audio ?: (if (anime) JAPANESE.first() else null) ?: prefs.audioLang).takeIf { it.isNotEmpty() }

    /** the subtitle index to show for [info] while [audioIndex] plays (null = the default track), or null for none */
    fun subtitle(info: PlaybackInfo, audioIndex: Int? = info.audioIndex): Int? {
        val series = pref.subtitle
        val want = when {
            wantSub == "off" -> null
            wantSub != null -> wantSub
            series == "off" -> null
            series != null && info.subtitles.any { it.language == series } -> series
            else -> animeSubtitle(info, audioIndex) ?: prefs.subtitleLang.takeIf { it.isNotEmpty() }
        } ?: return null
        return info.subtitles.firstOrNull { it.language == want }?.index
    }

    /** the anime default's subtitle language as the answer names it, only while a Japanese track plays (a dub keeps the defaults) */
    private fun animeSubtitle(info: PlaybackInfo, audioIndex: Int?): String? {
        if (!anime || wantAudio != null) return null
        val playing = info.audioTracks.firstOrNull { it.index == audioIndex } ?: info.audioTracks.firstOrNull { it.isDefault }
        val japanese = playing?.language?.lowercase() in JAPANESE
        val lang = animeChoice(pref, prefs.animeOriginal, appLang, japanese)?.subtitleLang ?: return null
        val codes = TRACK_CODES[lang] ?: listOf(lang)
        return info.subtitles.firstOrNull { it.language?.lowercase() in codes }?.language
    }

    companion object {
        private val JAPANESE = listOf("jpn", "ja")
        /** ISO 639-2 codes the media server reports for the app languages (bibliographic and terminology forms) */
        private val TRACK_CODES = mapOf("ger" to listOf("ger", "deu"), "eng" to listOf("eng"))

        /** the app language as an ISO 639-2 track code, as the web maps its UI language: German → "ger", else "eng" */
        fun appLang(locale: Locale): String = if (locale.language == "de") "ger" else "eng"
    }
}
