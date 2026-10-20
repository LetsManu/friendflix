// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import app.friendflix.android.R

/**
 * The player's panel host (the web player's menus): one panel at a time as a bottom sheet over the video, the video dimmed
 * behind it. A tap on the dimmed video, the close button or Back closes it; playback is never touched. [back] is registered on
 * the activity's back dispatcher and is only enabled while a panel is open, so Back closes the panel before the player.
 */
class PlayerPanel(private val root: FrameLayout) {
    private var frame: View? = null
    private var onClose: (() -> Unit)? = null

    /** the open panel's content (null when none is open) */
    var content: View? = null
        private set

    val isOpen: Boolean get() = content != null

    /** Back closes the open panel first (enabled only while one is open); a panel with its own levels ([BackAware]) steps back first. */
    val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            if ((content as? BackAware)?.back() == true) return
            close()
        }
    }

    /** Shows [content] under [title]; an open panel is replaced (its [onClose] runs first). */
    fun show(title: CharSequence, content: View, onClose: () -> Unit = {}) {
        val f = frame ?: inflate()
        if (isOpen) close()
        f.findViewById<TextView>(R.id.player_panel_title).text = title
        val box = f.findViewById<FrameLayout>(R.id.player_panel_content)
        box.removeAllViews()
        (content.parent as? ViewGroup)?.removeView(content)
        box.addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        f.findViewById<ScrollView>(R.id.player_panel_scroll).scrollTo(0, 0)
        ViewCompat.setAccessibilityPaneTitle(f.findViewById(R.id.player_panel_sheet), title)
        this.content = content
        this.onClose = onClose
        f.visibility = View.VISIBLE
        back.isEnabled = true
    }

    /** Closes the open panel; false when none was open. */
    fun close(): Boolean {
        val f = frame ?: return false
        if (!isOpen) return false
        f.visibility = View.GONE
        f.findViewById<FrameLayout>(R.id.player_panel_content).removeAllViews()
        content = null
        back.isEnabled = false
        val cb = onClose
        onClose = null
        cb?.invoke()
        return true
    }

    private fun inflate(): View {
        val f = LayoutInflater.from(root.context).inflate(R.layout.player_panel, root, false)
        root.addView(f)
        f.findViewById<View>(R.id.player_panel_scrim).setOnClickListener { close() }
        f.findViewById<View>(R.id.player_panel_close).setOnClickListener { close() }
        // taps inside the sheet stay in the sheet (never reach the dimmed video behind)
        f.findViewById<View>(R.id.player_panel_sheet).isClickable = true
        ViewCompat.setAccessibilityHeading(f.findViewById(R.id.player_panel_title), true)
        frame = f
        return f
    }
}

/** A panel content with levels (More → Speed / Quality / Sleep timer): [back] steps up one level, false on the top level. */
interface BackAware {
    fun back(): Boolean
}

/**
 * The panel's sheet: at most [PHONE_MAX_HEIGHT] of the available height on phones ([TABLET_MAX_HEIGHT] on larger screens) and at
 * most [MAX_WIDTH_DP] wide, so the video stays visible above it; the content scrolls inside.
 */
class PanelSheet @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : LinearLayout(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val density = resources.displayMetrics.density
        val maxW = (MAX_WIDTH_DP * density).toInt()
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val ws = if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED && w > maxW) MeasureSpec.makeMeasureSpec(maxW, MeasureSpec.EXACTLY) else widthMeasureSpec
        val h = MeasureSpec.getSize(heightMeasureSpec)
        val hs = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.UNSPECIFIED) {
            heightMeasureSpec
        } else {
            val phone = resources.configuration.smallestScreenWidthDp < TABLET_MIN_DP
            MeasureSpec.makeMeasureSpec((h * if (phone) PHONE_MAX_HEIGHT else TABLET_MAX_HEIGHT).toInt(), MeasureSpec.AT_MOST)
        }
        super.onMeasure(ws, hs)
    }

    private companion object {
        const val MAX_WIDTH_DP = 560
        const val TABLET_MIN_DP = 600
        const val PHONE_MAX_HEIGHT = 0.6f
        const val TABLET_MAX_HEIGHT = 0.7f
    }
}
