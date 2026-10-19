// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** A media segment from `GET /api/items/:id/segments` (seconds; type lowercased: intro | outro | recap | preview). */
data class Segment(val type: String, val startSec: Double, val endSec: Double)

/** The profile preferences the flow uses (`GET /api/prefs`; defaults = the web's DEFAULT_PREFS). */
data class FlowPrefs(
    val autoplayNext: Boolean = true,
    val autoSkipIntro: Boolean = false,
    val stillWatching: Boolean = true,
    val stillWatchingEpisodes: Int = 3,
)

/** web lib/player/nextup.ts `NextKind`: an episode with a next one, a film, or nothing follows. */
enum class NextKind {
    EPISODE, MOVIE, NONE;

    companion object {
        fun of(type: String?, hasNext: Boolean): NextKind = when (type) {
            "Episode" -> if (hasNext) EPISODE else NONE
            "Movie" -> MOVIE
            else -> NONE
        }
    }
}

/** What the next-up area shows. */
sealed interface FlowCard {
    data object Hidden : FlowCard
    /** "Next episode" (with the countdown while [counting]; [secondsLeft] like the web's `secondsLeft`) */
    data class NextUp(val counting: Boolean, val secondsLeft: Int) : FlowCard
    /** "Still there?": autoplay is held until the viewer answers */
    data object StillThere : FlowCard
}

/** One update's result: what to show, and whether to move on to the next episode now ([autoplay] = the countdown did it). */
data class EpisodeStep(val card: FlowCard, val goNext: Boolean = false, val autoplay: Boolean = false)

/**
 * "Are you still watching?" (web lib/stillwatching.ts): a chain of episodes started by the countdown and the time of the last real
 * viewer action. Lives for the process (the web keeps it per tab in sessionStorage); one instance is shared by all episodes.
 */
class StillWatching(private val now: () -> Long) {
    private var chain = 0
    private var lastInteraction = now()
    private var autoplayed = false

    /** A real viewer action (tap, key, remote button): the chain starts over. */
    @Synchronized fun noteInteraction() { chain = 0; lastInteraction = now() }

    /** The countdown started the next episode. */
    @Synchronized fun noteAutoplay() { autoplayed = true; chain += 1 }

    /** An episode was opened: by the countdown (consumed), else by the viewer (an interaction). */
    @Synchronized fun opened() { if (autoplayed) autoplayed = false else noteInteraction() }

    @Synchronized fun shouldAsk(p: FlowPrefs): Boolean {
        if (!p.stillWatching) return false
        val n = if (p.stillWatchingEpisodes > 0) p.stillWatchingEpisodes else 3
        return chain >= n || now() - lastInteraction >= IDLE_MS
    }

    companion object {
        const val IDLE_MS = 90 * 60_000L
    }
}

/**
 * Skip button, intro auto-skip and the credits card of one title, with the web player's markers and timings
 * (Player.svelte `skip` / auto-skip / `doSkip`, lib/player/nextup.ts, routes/watch/[id] `enterCard` / `startCountdown` / `onEnded`):
 * - skip button: inside a segment that is not a recap, until one second before its end
 * - credits: from an outro / credits segment in the second half, else the last [LAST_SECONDS]
 * - at the credits an episode with a next one shows the next-up card; with autoplay on (and no "still there?") a [COUNTDOWN_MS]
 *   countdown runs only while the title plays (or has ended); seeking out of the credits hides the card and stops it
 * - "still there?" replaces the countdown when [StillWatching.shouldAsk]
 * Films get no card here (the web's "more like this" / post-play screen stay in the web UI).
 */
class EpisodeFlow(
    segments: List<Segment>,
    private val kind: NextKind,
    private val prefs: FlowPrefs,
    private val still: StillWatching,
) {
    private val segments = segments.map { it.copy(type = it.type.lowercase()) }
    /** seconds; 0 while unknown */
    var duration = 0.0
    private val autoSkipped = mutableSetOf<Double>()
    private var dismissed = false
    private var entered = false
    private var askStill = false
    private var counting = false
    private var elapsed = 0L

    /** The segment whose skip button shows at [current] seconds, or null. */
    fun skip(current: Double): Segment? = segments.firstOrNull { it.type != "recap" && current >= it.startSec && current < it.endSec - 1 }

    /** Intro auto-skip (profile setting): the second to jump to, once per intro. */
    fun autoSkip(current: Double): Double? {
        val s = skip(current) ?: return null
        if (s.type != "intro" || !prefs.autoSkipIntro || !autoSkipped.add(s.startSec)) return null
        return s.endSec
    }

    /** A preview at the very end is the next episode's teaser: its skip goes to the next episode instead of seeking into nothing. */
    fun skipGoesNext(s: Segment, hasNext: Boolean): Boolean = s.type == "preview" && duration > 0 && s.endSec >= duration - 3 && hasNext

    /** Second the credits begin (Infinity while the duration is unknown). */
    fun creditsStart(): Double {
        if (duration <= 0) return Double.POSITIVE_INFINITY
        val fallback = maxOf(0.0, duration - LAST_SECONDS)
        val seg = segments.filter { (it.type == "outro" || it.type == "credits") && it.startSec > 0 && it.startSec < duration }.minByOrNull { it.startSec }
        return if (seg != null && seg.startSec >= duration / 2) seg.startSec else fallback
    }

    /**
     * Called about every 100 ms - 1 s with the position, whether the title plays / has ended, and the ms since the last call.
     * Returns the card and, when the countdown ran out, `goNext` (the flow already counted the autoplay).
     */
    fun update(current: Double, playing: Boolean, ended: Boolean, dtMs: Long): EpisodeStep {
        val start = creditsStart()
        val visible = kind != NextKind.NONE && !dismissed && start.isFinite() && current >= start
        if (visible && !entered) enterCard() else if (!visible && entered) leaveCard()
        if (counting && (playing || ended)) {
            elapsed = minOf(COUNTDOWN_MS, elapsed + maxOf(0L, dtMs))
            if (elapsed >= COUNTDOWN_MS) {
                stopCountdown()
                still.noteAutoplay()
                return EpisodeStep(card(visible), goNext = true, autoplay = true)
            }
        }
        return EpisodeStep(card(visible))
    }

    private fun card(visible: Boolean): FlowCard = when {
        !visible || kind != NextKind.EPISODE -> FlowCard.Hidden
        askStill -> FlowCard.StillThere
        else -> FlowCard.NextUp(counting, secondsLeft())
    }

    private fun secondsLeft(): Int = maxOf(0, ((COUNTDOWN_MS - elapsed + 999) / 1000).toInt())

    private fun enterCard() {
        entered = true
        if (kind != NextKind.EPISODE) return
        if (prefs.autoplayNext && still.shouldAsk(prefs)) { askStill = true; return }
        if (prefs.autoplayNext && !askStill) startCountdown()
    }

    private fun leaveCard() { entered = false; stopCountdown(); askStill = false }
    private fun startCountdown() { stopCountdown(); counting = true }
    private fun stopCountdown() { counting = false; elapsed = 0 }

    /** "Watch credits": hide the card, keep watching, no countdown (it comes back at the end). */
    fun watchCredits() { dismissed = true; stopCountdown(); askStill = false }

    /** The title ended: a dismissed card comes back (with its countdown). */
    fun onEnded() { if (kind == NextKind.EPISODE && dismissed) { dismissed = false; entered = false } }

    /** "Continue watching" on the still-there card: an interaction, then the next episode. */
    fun keepWatching(): EpisodeStep {
        still.noteInteraction()
        askStill = false
        return EpisodeStep(FlowCard.Hidden, goNext = true)
    }

    /** The "Next episode" button. */
    fun goNow(): EpisodeStep { stopCountdown(); return EpisodeStep(FlowCard.Hidden, goNext = true) }

    companion object {
        const val LAST_SECONDS = 25.0
        const val COUNTDOWN_MS = 10_000L
    }
}
