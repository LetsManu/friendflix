// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import org.junit.Assert.assertEquals
import org.junit.Test

class TitleSwitchTest {
    private val log = mutableListOf<String>()
    private var casting = false
    private val switch = TitleSwitch(object : TitleSwitch.Steps {
        override fun newTitle() { log += "newTitle" }
        override fun casting() = casting
        override fun playOnTv(id: String) { log += "tv:$id" }
        override fun cancelLoad() { log += "cancelLoad" }
        override fun resetLocal() { log += "reset" }
        override fun startOnline(id: String) { log += "start:$id" }
    })

    @Test fun aPickCancelsTheOldLoadBeforeTheNewTitleStarts() {
        switch.play("e2")
        assertEquals(listOf("newTitle", "cancelLoad", "reset", "start:e2"), log)
    }

    @Test fun whileCastingThePickGoesToTheTvAndTheLocalPlayerIsLeftAlone() {
        casting = true
        switch.play("e2")
        assertEquals(listOf("newTitle", "tv:e2"), log)
    }
}
