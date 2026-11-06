// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * The web player's fullscreen (the page's `requestFullscreen()` on a video): the WebView hands over a view that [show] puts over the
 * whole screen in [container], with the system bars hidden (a swipe shows them for a moment). [exit] (Android back) leaves it; the
 * page leaving fullscreen itself ends in [hide].
 */
class FullscreenVideo(private val container: FrameLayout, private val window: Window?) {
    private var view: View? = null
    private var callback: WebChromeClient.CustomViewCallback? = null

    val isShowing: Boolean get() = view != null

    fun show(v: View, cb: WebChromeClient.CustomViewCallback) {
        if (view != null) { cb.onCustomViewHidden(); return } // one at a time: the second request is refused
        view = v
        callback = cb
        container.addView(v, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        container.visibility = View.VISIBLE
        bars()?.let {
            it.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            it.hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    /** The page left fullscreen (or [exit] asked it to): the normal layout comes back. Safe to call twice. */
    fun hide() {
        val v = view ?: return
        view = null
        callback = null
        container.removeView(v)
        container.visibility = View.GONE
        bars()?.show(WindowInsetsCompat.Type.systemBars())
    }

    /** Back while in fullscreen: leave it and tell the page. */
    fun exit() {
        val cb = callback
        hide()
        cb?.onCustomViewHidden()
    }

    private fun bars(): WindowInsetsControllerCompat? = window?.let { WindowCompat.getInsetsController(it, it.decorView) }
}

/** The shell's WebChromeClient: only the video fullscreen. Without a [fullscreen] host a fullscreen request is refused at once. */
class ShellChromeClient(private val fullscreen: FullscreenVideo?) : WebChromeClient() {
    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        if (fullscreen == null) callback.onCustomViewHidden() else fullscreen.show(view, callback)
    }

    override fun onHideCustomView() {
        fullscreen?.hide()
    }
}
