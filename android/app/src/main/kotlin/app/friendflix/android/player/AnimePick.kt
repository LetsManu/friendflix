// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** The audio / subtitle language to start an anime episode with (web lib/player/anime.ts). */
data class AnimeChoice(val audioLang: String?, val subtitleLang: String?)

/**
 * Original audio with subtitles, only for anime when the profile wants it and the series has no own choice yet.
 * [appLang] is an ISO 639-2 code; the subtitle is asked for only while the playing audio is Japanese.
 */
fun animeChoice(pref: LangPref, animeOriginal: Boolean, appLang: String, audioIsJapanese: Boolean): AnimeChoice? {
    if (!(animeOriginal && pref.anime && pref.audio == null && pref.subtitle == null)) return null
    return AnimeChoice("jpn", if (audioIsJapanese) appLang else null)
}
