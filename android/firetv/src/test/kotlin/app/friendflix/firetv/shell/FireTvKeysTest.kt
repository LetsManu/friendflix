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

    // Live TV (Phase 1): the web names `resolveLiveKey` reads. Raw codes pin the Android numbers.
    private val liveKeys = mapOf(
        166 to "ChannelUp", 167 to "ChannelDown", // KEYCODE_CHANNEL_UP / _DOWN
        7 to "0", 8 to "1", 9 to "2", 10 to "3", 11 to "4", 12 to "5", 13 to "6", 14 to "7", 15 to "8", 16 to "9", // KEYCODE_0..9
        229 to "PreviousChannel", // KEYCODE_LAST_CHANNEL
        165 to "Info", // KEYCODE_INFO
        172 to "Guide", // KEYCODE_GUIDE: the Senderliste panel in Phase 1
    )

    @Test fun `webKey maps each new code`() {
        for ((code, name) in liveKeys) assertEquals("code $code", name, FireTvKeys.webKey(code))
        assertNull(FireTvKeys.webKey(92)); assertNull(FireTvKeys.webKey(93)) // PAGE_UP / PAGE_DOWN stay native
    }

    @Test fun `route dispatches the first key-down and swallows repeats of ChannelUp`() {
        assertEquals(FireTvKeys.Route.Dispatch("ChannelUp"), FireTvKeys.route(0, 166, 0))
        for (n in 1..5) assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(0, 166, n)) // held: one channel, not a race
        assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(1, 166, 0)) // key up
        for ((code, name) in liveKeys) {
            assertEquals(FireTvKeys.Route.Dispatch(name), FireTvKeys.route(0, code, 0))
            assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(0, code, 1))
            assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(1, code, 0))
        }
    }

    @Test fun `script accepts the new names and still refuses unknown ones`() {
        for (name in liveKeys.values) {
            val js = FireTvKeys.script(name)
            assertTrue(name, js.contains("key:'$name'"))
            assertFalse(name, js.contains("blur()"))
        }
        for (bad in listOf("Enter", "PageUp", "ColorF0Red", "ChannelList", "10", "channelup", "0');alert(1);('")) {
            assertThrows(bad, IllegalArgumentException::class.java) { FireTvKeys.script(bad) }
        }
    }

    @Test fun `DPAD_CENTER is not intercepted`() {
        // the page measures a long OK (Senderliste) from OK's own keydown, repeats and keyup: all of them reach the WebView
        assertNull(FireTvKeys.webKey(23))
        assertEquals(FireTvKeys.Route.Pass, FireTvKeys.route(0, 23, 0)) // down
        for (n in 1..10) assertEquals(FireTvKeys.Route.Pass, FireTvKeys.route(0, 23, n)) // held: repeats
        assertEquals(FireTvKeys.Route.Pass, FireTvKeys.route(1, 23, 0)) // up
        assertEquals(FireTvKeys.Route.Pass, FireTvKeys.route(1, 23, 7)) // up after a long hold
    }

    @Test fun `a digit types into a focused text field instead of firing a keydown`() {
        for (d in 0..9) {
            val js = FireTvKeys.script("$d")
            assertTrue(js.contains("t.isContentEditable||t.tagName==='TEXTAREA'||(t.tagName==='INPUT'"))
            assertTrue(js.contains("document.execCommand('insertText',false,'$d');return 'typed';"))
            // the field check comes before the keydown, so a typed digit never also reaches the page as a key
            assertTrue(js.indexOf("insertText") < js.indexOf("KeyboardEvent('keydown'"))
        }
        for (name in listOf("ChannelUp", "ChannelDown", "PreviousChannel", "Info", "Guide", "MediaPlayPause", "GoBack")) {
            assertFalse(name, FireTvKeys.script(name).contains("insertText"))
            assertFalse(name, FireTvKeys.script(name).contains("'typed'"))
        }
        // Back keeps the same field test for leaving the field
        assertTrue(FireTvKeys.script("GoBack").contains("t.isContentEditable||t.tagName==='TEXTAREA'"))
    }
}
