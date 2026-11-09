// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import android.view.KeyEvent

/**
 * The remote keys the shell hands to the page as `keydown` events with the standard key names the web UI understands
 * (`isBackKey` in lib/spatial.ts, `resolveKey` in lib/player/keymap.ts). D-pad, OK, Menu, volume and Home reach the page (or the
 * system) natively and are not listed here.
 */
object FireTvKeys {
    const val BACK = "GoBack"

    private val KEYS = mapOf(
        KeyEvent.KEYCODE_BACK to BACK,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "MediaPlayPause",
        KeyEvent.KEYCODE_MEDIA_PLAY to "MediaPlay",
        KeyEvent.KEYCODE_MEDIA_PAUSE to "MediaPause",
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to "MediaFastForward",
        KeyEvent.KEYCODE_MEDIA_REWIND to "MediaRewind",
        KeyEvent.KEYCODE_MEDIA_NEXT to "MediaTrackNext",
    )

    fun webKey(keyCode: Int): String? = KEYS[keyCode]

    sealed interface Route {
        /** not a key of ours: normal dispatch */
        data object Pass : Route
        /** a repeat or key-up of one of our keys: consumed, nothing happens (holding Fast-forward does not skip minutes) */
        data object Swallow : Route
        /** the first key-down: the page gets [key] */
        data class Dispatch(val key: String) : Route
    }

    fun route(action: Int, keyCode: Int, repeatCount: Int): Route {
        val key = webKey(keyCode) ?: return Route.Pass
        return if (action == KeyEvent.ACTION_DOWN && repeatCount == 0) Route.Dispatch(key) else Route.Swallow
    }

    /**
     * The script that fires [key] at the focused element (bubbling, cancelable) and returns `'handled'` when the page called
     * preventDefault, `'blurred'` when Back left a text field, else `'unhandled'`. Only the known names are ever put in the script.
     */
    fun script(key: String): String {
        require(key in KEYS.values) { "unknown key" }
        val blur = if (key == BACK) {
            "var n=t.tagName;if(t.isContentEditable||n==='TEXTAREA'||(n==='INPUT'&&!/^(checkbox|radio|range|button|submit)\$/.test(t.type))){t.blur();return 'blurred';}"
        } else {
            ""
        }
        return "(function(){var t=document.activeElement||document.body;if(!t)return 'unhandled';" +
            "var ok=t.dispatchEvent(new KeyboardEvent('keydown',{key:'$key',bubbles:true,cancelable:true}));" +
            "t.dispatchEvent(new KeyboardEvent('keyup',{key:'$key',bubbles:true}));" +
            "if(!ok)return 'handled';" + blur + "return 'unhandled';})()"
    }
}
