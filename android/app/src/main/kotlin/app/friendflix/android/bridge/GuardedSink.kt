// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.bridge

/**
 * The reply sink of one page: [toUi] queues a runnable on the UI thread (View.post), [deliver] hands the JSON to the page's reply proxy.
 * The runnable is queued now but runs later; if the activity finished meanwhile (the WebView destroyed, the bridge detached) the proxy
 * is dead and posting to it crashes the process, so the check happens when it runs, not when it is queued. A proxy that throws anyway
 * (frame gone) is ignored: the next page registers on its first message.
 */
internal fun uiReplySink(bridge: NativeBridge, toUi: (Runnable) -> Unit, deliver: (String) -> Unit): ReplySink = ReplySink { json ->
    toUi(Runnable {
        if (!bridge.isDetached) {
            try { deliver(json) } catch (_: Exception) { /* the frame went away */ }
        }
    })
}
