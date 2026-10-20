// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.json.JSONObject

/**
 * web lib/postplay.ts `postplayWanted`: the post-play card and screen only when the server has the feature on, the profile did not
 * switch it off, no next episode follows (the next-episode card handles that), it is a film or an episode, it does not play on a
 * TV and it streams from the server (never a download).
 */
fun postplayWanted(type: String?, hasNextEpisode: Boolean, feature: Boolean, pref: Boolean, casting: Boolean, online: Boolean): Boolean =
    feature && pref && !casting && online && !hasNextEpisode && (type == "Movie" || type == "Episode")

/**
 * The end of one title (routes/watch/[id] `ppCard` / `prefetchPostplay` / `onEnded` / `loadSimilar`): from the post-play time the
 * "Done? See what's next" card shows and the answer of `/postplay` is fetched; at the end the screen opens by itself. A film
 * without post-play gets "More like this" ([MAX_SIMILAR] titles of `/similar`, itself left out) at the end. With nothing to show
 * (the request failed, no similar titles) the player closes as before. Nothing ever starts playing by itself.
 */
class PostPlayFlow(private val itemId: String, private val movie: Boolean) {
    enum class Fetch { POSTPLAY, SIMILAR }

    /** What the end of the title (or an answer the end waited for) does. */
    sealed interface End {
        data class Open(val data: JSONObject) : End
        data class More(val titles: List<Title>) : End
        /** nothing to show: the player closes, as before */
        data object Finish : End
        /** the answer is on its way (the end acts once it arrives) */
        data object Wait : End
        /** an episode without post-play: the screen stays as before */
        data object Stay : End
        /** the card was tapped and the answer failed: the web's error text */
        data object Failed : End
    }

    /** the post-play answer (null until loaded, or when it failed) */
    var data: JSONObject? = null
        private set
    private var loading = false
    private var failed = false
    private var similar: List<Title>? = null
    private var similarLoading = false
    private var cardClosed = false
    /** the screen was opened (the card goes for good, like the web's ppCardClosed after it) */
    private var opened = false
    private var ended = false
    /** the end waits for an answer; the value is whether post-play was wanted then */
    private var pendingEnd: Boolean? = null
    /** the card was tapped before the answer arrived */
    private var pendingOpen = false

    private fun due(current: Double, atSec: Double) = ended || (atSec.isFinite() && current >= atSec)

    /** The "Done? See what's next" card shows. */
    fun card(wanted: Boolean, current: Double, atSec: Double): Boolean =
        wanted && !cardClosed && !opened && !failed && atSec.isFinite() && current >= atSec

    /** What to request now (each once): the post-play answer when wanted, else the similar titles of a film. */
    fun fetch(wanted: Boolean, current: Double, atSec: Double): Fetch? {
        if (!due(current, atSec)) return null
        if (wanted && data == null && !loading && !failed) { loading = true; return Fetch.POSTPLAY }
        if (!wanted && movie && similar == null && !similarLoading) { similarLoading = true; return Fetch.SIMILAR }
        return null
    }

    /** The post-play answer ([d] null = failed); what a waiting end or card tap does now (null: nothing waited). */
    fun loaded(d: JSONObject?): End? {
        loading = false
        if (d == null) failed = true else data = d
        if (pendingOpen) {
            pendingOpen = false
            if (d == null) return End.Failed
            opened = true
            return End.Open(d)
        }
        return pendingEnd?.let { endAction(it) }
    }

    /** The similar titles of a film ([list] null = failed: none). */
    fun similarLoaded(list: List<Title>?): End? {
        similarLoading = false
        similar = list.orEmpty().filter { it.id != itemId }.take(MAX_SIMILAR)
        return pendingEnd?.let { endAction(it) }
    }

    /** "What's next?" on the card: the screen, or null while the answer is on its way (it opens when it arrives). */
    fun openCard(): End? {
        data?.let { opened = true; return End.Open(it) }
        if (failed) return End.Failed
        pendingOpen = true
        return null
    }

    /** "Hide this hint" on the card */
    fun closeCard() { cardClosed = true }

    /** The title ended locally; [wanted] = post-play is wanted now. */
    fun onEnded(wanted: Boolean): End {
        ended = true
        return endAction(wanted)
    }

    private fun endAction(wanted: Boolean): End {
        pendingEnd = null
        if (wanted) {
            data?.let { opened = true; return End.Open(it) }
            if (failed) return End.Finish
            pendingEnd = true
            return End.Wait
        }
        if (!movie) return End.Stay
        val s = similar ?: run { pendingEnd = false; return End.Wait }
        return if (s.isEmpty()) End.Finish else End.More(s)
    }

    companion object {
        const val MAX_SIMILAR = 3
    }
}
