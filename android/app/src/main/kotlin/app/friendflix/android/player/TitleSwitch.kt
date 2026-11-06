// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/**
 * Another title in this player (the next episode, a pick in the Episodes panel): one path for both. The per-title state is reset
 * (speed 1, a sleep timer "after this episode" consumed); while casting the title plays on the TV and the local player is left
 * alone; otherwise the old title's load or retry is cancelled first (it must never attach the old title or start a second
 * session later), its playback state is dropped and the new title starts.
 */
class TitleSwitch(private val steps: Steps) {
    interface Steps {
        /** the controls' per-title state ([PlayerControls.newTitle]) */
        fun newTitle()
        fun casting(): Boolean
        fun playOnTv(id: String)
        /** the old title's load / retry job stops and its error box goes */
        fun cancelLoad()
        /** reporter, stream, flow, languages and the local player of the old title are released */
        fun resetLocal()
        fun startOnline(id: String)
    }

    fun play(id: String) {
        steps.newTitle()
        if (steps.casting()) { steps.playOnTv(id); return }
        steps.cancelLoad()
        steps.resetLocal()
        steps.startOnline(id)
    }
}
