// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class FireTvKeysTest {
    @Test fun mapsTheRemoteKeys() {
        assertEquals("GoBack", FireTvKeys.webKey(4)); assertEquals("MediaPlayPause", FireTvKeys.webKey(85))
        assertEquals("MediaPlay", FireTvKeys.webKey(126)); assertEquals("MediaPause", FireTvKeys.webKey(127))
        assertEquals("MediaFastForward", FireTvKeys.webKey(90)); assertEquals("MediaRewind", FireTvKeys.webKey(89))
        assertEquals("MediaTrackNext", FireTvKeys.webKey(87))
        for (dpad in listOf(19, 20, 21, 22, 23, 66, 82, 24, 25, 3)) assertNull(FireTvKeys.webKey(dpad))
    }

    @Test fun onlyTheFirstKeyDownIsDispatched() {
        assertEquals(FireTvKeys.Route.Dispatch("MediaFastForward"), FireTvKeys.route(0, 90, 0))
        assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(0, 90, 1)) // held: repeats
        assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(1, 90, 0)) // key up
        assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(1, 4, 0))
        assertEquals(FireTvKeys.Route.Pass, FireTvKeys.route(0, 23, 0)) // OK stays native
        assertEquals(FireTvKeys.Route.Pass, FireTvKeys.route(0, 22, 0))
    }

    @Test fun scriptOnlyForKnownKeysAndBlursOnlyOnBack() {
        assertTrue(FireTvKeys.script("GoBack").contains("key:'GoBack'"))
        assertTrue(FireTvKeys.script("GoBack").contains("blur()"))
        assertFalse(FireTvKeys.script("MediaPlayPause").contains("blur()"))
        assertThrows(IllegalArgumentException::class.java) { FireTvKeys.script("x');alert(1);('") }
    }
}
