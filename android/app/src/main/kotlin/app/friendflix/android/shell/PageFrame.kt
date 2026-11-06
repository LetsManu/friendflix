// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.content.Context
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** The web app's page background (`--bg` in web/src/app.css), behind the transparent system bars. */
internal val PAGE_BACKGROUND = Color.rgb(0x10, 0x14, 0x18)

/**
 * The frame the WebView sits in, padded by the system bars and the keyboard. A WebView ignores its own padding and would draw the
 * page's header under the status bar, so the frame takes the insets and consumes them (the page then sees no safe-area insets and
 * adds no second gap). The frame's colour is the page background, so the bars sit on it.
 */
internal fun pageFrame(context: Context, web: View): FrameLayout = FrameLayout(context).apply {
    setBackgroundColor(PAGE_BACKGROUND)
    addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
        v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        WindowInsetsCompat.CONSUMED
    }
}
