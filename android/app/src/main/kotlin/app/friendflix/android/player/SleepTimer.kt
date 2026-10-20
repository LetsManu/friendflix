// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** The sleep timer: pause after N minutes, or after the current episode (web Player.svelte). One mode at a time. */
class SleepTimer(private val now: () -> Long) {
    private var dueAt: Long? = null
    var afterEpisode: Boolean = false
        private set

    fun set(minutes: Int) {
        afterEpisode = false
        dueAt = now() + minutes * 60_000L
    }

    fun setAfterEpisode() {
        dueAt = null
        afterEpisode = true
    }

    fun off() {
        dueAt = null
        afterEpisode = false
    }

    /** ms until the timer fires, null when no minute timer runs. */
    fun remainingMs(): Long? = dueAt?.let { maxOf(0L, it - now()) }

    /** true once when the time has passed, then the timer is cleared. */
    fun due(): Boolean {
        val d = dueAt ?: return false
        if (now() < d) return false
        dueAt = null
        return true
    }
}
