// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.graphics.Typeface
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import app.friendflix.android.R
import app.friendflix.android.player.Chapter
import app.friendflix.android.player.ImageLoader
import app.friendflix.android.player.chapterIndexAt
import app.friendflix.android.player.timeLabel
import kotlinx.coroutines.CoroutineScope

/**
 * The web player's *Scenes* panel (ScenesPanel.svelte): the count, then one row per chapter with its still (the server's chapter
 * image, loaded with [images] on [scope]), its start time and its name ("Chapter 3" when unnamed); the playing one is marked.
 * A tap calls [onSeek] with the chapter's start in seconds. [chapters] are already normalised ([app.friendflix.android.player.normaliseChapters]).
 */
object ScenesPanel {
    fun build(
        ctx: Context,
        scope: CoroutineScope,
        images: ImageLoader?,
        chapters: List<Chapter>,
        currentSec: Double,
        onSeek: (Double) -> Unit,
    ): View {
        val col = PanelRows.column(ctx)
        col.addView(PanelRows.note(ctx, ctx.resources.getQuantityString(R.plurals.player_scenes_count, chapters.size, chapters.size)))
        val list = PanelRows.column(ctx).apply { id = R.id.scenes_list }
        val playing = chapterIndexAt(chapters, currentSec)
        for ((i, c) in chapters.withIndex()) list.addView(row(ctx, scope, images, c, i, i == playing, onSeek))
        col.addView(list)
        return col
    }

    /** the shown name: its own, else "Chapter 3" (web chapterLabel) */
    fun label(ctx: Context, c: Chapter, index: Int): String = c.name.ifEmpty { ctx.getString(R.string.player_scenes_chapter, index + 1) }

    private fun row(
        ctx: Context, scope: CoroutineScope, images: ImageLoader?, c: Chapter, index: Int, current: Boolean, onSeek: (Double) -> Unit,
    ): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        val p = PanelRows.dp(ctx, 12)
        setPadding(p, PanelRows.dp(ctx, 6), p, PanelRows.dp(ctx, 6))
        isClickable = true
        isFocusable = true
        val name = label(ctx, c, index)
        val start = timeLabel(c.startSec.toLong())
        contentDescription = ctx.getString(R.string.player_scenes_jump, name, start)
        isSelected = current
        background = if (current) ContextCompat.getDrawable(ctx, R.drawable.player_episode_current) else PanelRows.selectable(ctx)
        setOnClickListener { onSeek(c.startSec) }

        val thumb = FrameLayout(ctx).apply {
            setBackgroundColor(THUMB_BG)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        val still = ImageView(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        thumb.addView(still, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (images != null && c.image != null) images.into(still, c.image, PanelRows.dp(ctx, THUMB_DP), scope)
        else still.setImageResource(R.drawable.ic_player_scenes).also { still.scaleType = ImageView.ScaleType.CENTER }
        thumb.addView(TextView(ctx).apply {
            text = start
            setTextColor(ContextCompat.getColor(ctx, android.R.color.white))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setBackgroundColor(TIME_BG)
            val tp = PanelRows.dp(ctx, 4)
            setPadding(tp, 0, tp, 0)
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            val m = PanelRows.dp(ctx, 4)
            setMargins(m, m, m, m)
        })
        addView(thumb, LinearLayout.LayoutParams(PanelRows.dp(ctx, THUMB_DP), PanelRows.dp(ctx, THUMB_DP * 9 / 16)).apply { marginEnd = PanelRows.dp(ctx, 12) })

        addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(ctx).apply {
                text = name
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.END
                setTextColor(ContextCompat.getColor(ctx, android.R.color.white))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                setTypeface(typeface, Typeface.BOLD)
            })
            if (current) addView(TextView(ctx).apply {
                text = ctx.getString(R.string.player_scenes_current)
                setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            })
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    private const val THUMB_DP = 128
    private const val THUMB_BG = 0xFF242B33.toInt()
    private const val TIME_BG = 0xBF000000.toInt()
}
