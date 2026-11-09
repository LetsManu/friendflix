// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

enum class BackAction { NONE, GO_BACK, EXIT }

object TvBack {
    /**
     * What Back does after the page saw it. [result] is the JSON `evaluateJavascript` returned for [FireTvKeys.script]: the page
     * handled it or a text field lost the focus → nothing more; anything else (not handled, no page such as an error page, garbage)
     * → one step back in the WebView's history, or leave the app when there is none.
     */
    fun after(result: String?, canGoBack: Boolean): BackAction = when (result) {
        "\"handled\"", "\"blurred\"" -> BackAction.NONE
        else -> if (canGoBack) BackAction.GO_BACK else BackAction.EXIT
    }
}
