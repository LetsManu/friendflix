// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.content.Intent
import android.text.InputFilter
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.isEmpty
import app.friendflix.android.R
import app.friendflix.android.player.ApiResult
import app.friendflix.android.player.Bookmark
import app.friendflix.android.player.PlayerApi
import app.friendflix.android.player.shareUrl
import app.friendflix.android.player.timeLabel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The web player's *Bookmarks* menu (Player.svelte `menu === 'scenes'`): *Share scene (12:34)* ([onShare] gets the watch link at
 * the current position), a note (max 140) with an add button, then the title's bookmarks (time and note); a tap calls [onSeek]
 * (ms), ✕ deletes it. [positionMs] is the active player's position (the TV's while casting). Every fresh list goes to [onChanged]
 * (the seek bar's marks). Requests run on the IO dispatcher from [scope]; a failed add or delete shows the web's text in the panel.
 */
object BookmarksPanel {
    const val NOTE_MAX = 140

    fun build(
        ctx: Context,
        scope: CoroutineScope,
        api: PlayerApi,
        itemId: String,
        positionMs: () -> Long,
        onSeek: (Long) -> Unit,
        onShare: (String) -> Unit,
        onChanged: (List<Bookmark>) -> Unit,
    ): View {
        val col = PanelRows.column(ctx)
        val p = PanelRows.dp(ctx, 16)
        val origin = api.server.origin.toString().trimEnd('/')

        col.addView(PanelRows.item(
            ctx, ctx.getString(R.string.player_bookmark_share, timeLabel(positionMs() / 1000)),
            { onShare(shareUrl(origin, itemId, positionMs().coerceAtLeast(0))) },
            id = R.id.bookmarks_share, icon = R.drawable.ic_player_share,
        ))

        val note = EditText(ctx).apply {
            id = R.id.bookmarks_note
            hint = ctx.getString(R.string.player_bookmark_note)
            filters = arrayOf(InputFilter.LengthFilter(NOTE_MAX))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = EditorInfo.IME_ACTION_DONE
            isSingleLine = true
            setTextColor(ContextCompat.getColor(ctx, android.R.color.white))
            setHintTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
        }
        val add = ImageButton(ctx).apply {
            id = R.id.bookmarks_add
            setImageResource(R.drawable.ic_player_bookmark)
            background = PanelRows.selectable(ctx)
            contentDescription = ctx.getString(R.string.player_bookmark_add)
            tooltipText = contentDescription
        }
        col.addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(p, 0, PanelRows.dp(ctx, 8), 0)
            addView(note, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(add, LinearLayout.LayoutParams(PanelRows.dp(ctx, 48), PanelRows.dp(ctx, 48)))
        })
        val msg = TextView(ctx).apply {
            id = R.id.bookmarks_msg
            visibility = View.GONE
            setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(p, PanelRows.dp(ctx, 4), p, PanelRows.dp(ctx, 4))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        col.addView(msg)
        val list = PanelRows.column(ctx).apply { id = R.id.bookmarks_list }
        col.addView(list)
        val none = PanelRows.note(ctx, ctx.getString(R.string.player_bookmark_none)).apply { visibility = View.GONE }
        col.addView(none)

        fun say(text: String?) {
            msg.text = text ?: ""
            msg.visibility = if (text == null) View.GONE else View.VISIBLE
        }

        lateinit var reload: () -> Unit
        fun show(items: List<Bookmark>) {
            list.removeAllViews()
            for (b in items) list.addView(row(ctx, b, { onSeek(b.positionSec * 1000L) }) {
                scope.launch {
                    val ok = withContext(Dispatchers.IO) { runCatching { api.removeBookmark(b.id) }.getOrDefault(false) }
                    say(if (ok) null else ctx.getString(R.string.player_bookmark_failed))
                    reload()
                }
            })
            none.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
            onChanged(items)
        }
        // a list that cannot be had keeps what is shown (web: the load's failure is ignored)
        reload = {
            scope.launch {
                val items = withContext(Dispatchers.IO) { runCatching { api.bookmarks(itemId) }.getOrNull() }
                if (items != null) show(items) else if (list.isEmpty()) none.visibility = View.VISIBLE
            }
        }

        var busy = false
        add.setOnClickListener {
            if (busy) return@setOnClickListener
            busy = true
            add.isEnabled = false
            say(null)
            val pos = (positionMs() / 1000).coerceAtLeast(0).toInt()
            val text = note.text.toString().trim().take(NOTE_MAX).ifEmpty { null }
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { api.addBookmark(itemId, pos, text) }.getOrElse { ApiResult.Err(0, null) } }
                busy = false
                add.isEnabled = true
                when (r) {
                    is ApiResult.Ok -> {
                        note.setText("")
                        say(ctx.getString(R.string.player_bookmark_set))
                        reload()
                    }
                    is ApiResult.Err -> say(ctx.getString(if (r.code == 409) R.string.player_bookmark_too_many else R.string.player_bookmark_failed))
                }
            }
        }
        reload()
        return col
    }

    /** The Android share sheet for [url] (plain text). */
    fun shareIntent(url: String): Intent =
        Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), null)

    private fun row(ctx: Context, b: Bookmark, onSeek: () -> Unit, onRemove: () -> Unit): View =
        PanelRows.item(ctx, b.note?.takeIf { it.isNotEmpty() } ?: ctx.getString(R.string.player_bookmark_title), onSeek, icon = R.drawable.ic_player_bookmark)
            .also { r ->
                // the time first (web: muted time, then the note)
                r.addView(TextView(ctx).apply {
                    text = timeLabel(b.positionSec.toLong())
                    setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                }, 1, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = PanelRows.dp(ctx, 12) })
                r.addView(ImageButton(ctx).apply {
                    id = R.id.bookmarks_remove
                    setImageResource(R.drawable.ic_player_close)
                    background = PanelRows.selectable(ctx)
                    contentDescription = ctx.getString(R.string.player_bookmark_remove)
                    tooltipText = contentDescription
                    setOnClickListener { onRemove() }
                }, LinearLayout.LayoutParams(PanelRows.dp(ctx, 44), PanelRows.dp(ctx, 44)))
            }
}
