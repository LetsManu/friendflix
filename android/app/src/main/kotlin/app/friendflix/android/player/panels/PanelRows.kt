// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import app.friendflix.android.R

/** The rows of the player panels, in the web player's menu style: a heading, then rows of icon (or check), text and detail. */
internal object PanelRows {
    fun column(ctx: Context): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    /** A section heading (the web's menu `h3`). */
    fun header(ctx: Context, text: CharSequence, id: Int = View.NO_ID): TextView = TextView(ctx).apply {
        this.id = id
        this.text = text
        setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        val p = dp(ctx, 16)
        setPadding(p, dp(ctx, 12), p, dp(ctx, 4))
        ViewCompat.setAccessibilityHeading(this, true)
    }

    /** A muted note under a section (why something is not available). */
    fun note(ctx: Context, text: CharSequence): TextView = TextView(ctx).apply {
        this.text = text
        setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        val p = dp(ctx, 16)
        setPadding(p, dp(ctx, 4), p, dp(ctx, 8))
    }

    /**
     * A tappable row. [checked] non-null makes it a choice of a list (check mark when chosen, announced as checked); otherwise
     * [icon] leads. [detail] is shown muted after the text (its view gets [detailId]); [chevron] marks a row that opens a list.
     */
    fun item(
        ctx: Context,
        text: CharSequence,
        onClick: () -> Unit,
        id: Int = View.NO_ID,
        icon: Int? = null,
        checked: Boolean? = null,
        detail: CharSequence? = null,
        detailId: Int = View.NO_ID,
        chevron: Boolean = false,
    ): LinearLayout = LinearLayout(ctx).apply {
        this.id = id
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(ctx, 48)
        val p = dp(ctx, 16)
        setPadding(p, 0, p, 0)
        background = selectable(ctx)
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
        val mark = if (checked != null) (if (checked) R.drawable.ic_player_check else null) else icon
        addView(ImageView(ctx).apply {
            if (mark != null) setImageResource(mark)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(ctx, 20), dp(ctx, 20)).apply { marginEnd = dp(ctx, 16) })
        addView(TextView(ctx).apply {
            this.text = text
            setTextColor(ContextCompat.getColor(ctx, android.R.color.white))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (detail != null || detailId != View.NO_ID) {
            addView(TextView(ctx).apply {
                this.id = detailId
                this.text = detail ?: ""
                setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(ctx, 8) })
        }
        if (chevron) {
            addView(TextView(ctx).apply {
                this.text = "›"
                setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(ctx, 8) })
        }
        if (checked != null) {
            isSelected = checked
            ViewCompat.setAccessibilityDelegate(this, object : AccessibilityDelegateCompat() {
                override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.className = Button::class.java.name
                    info.isCheckable = true
                    info.isChecked = checked
                }
            })
        }
    }

    fun selectable(ctx: Context) = TypedValue().let { tv ->
        ctx.theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true)
        ContextCompat.getDrawable(ctx, tv.resourceId)
    }

    fun dp(ctx: Context, v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()
}
