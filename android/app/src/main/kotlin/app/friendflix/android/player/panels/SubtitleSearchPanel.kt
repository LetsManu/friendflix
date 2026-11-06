// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.core.content.ContextCompat
import app.friendflix.android.R
import app.friendflix.android.player.ApiResult
import app.friendflix.android.player.PlayerApi
import app.friendflix.android.player.SubResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The web player's *Find subtitles* dialog (Jellyfin remote providers): a language (German, English, French, Spanish, Italian;
 * [defaultLang] preselected), *Search*, then the results as rows (name, provider · downloads); a tap downloads that subtitle and
 * calls [onAdded]. Requests run on the IO dispatcher from [scope] (the main scope); a failure shows the web's text in the panel.
 */
object SubtitleSearchPanel {
    /** the languages offered, as the providers' ISO 639-2 codes (web SUB_LANGS) */
    val LANGS = listOf("ger", "eng", "fre", "spa", "ita")

    private val LANG_NAMES = mapOf(
        "ger" to R.string.player_subs_lang_ger, "eng" to R.string.player_subs_lang_eng, "fre" to R.string.player_subs_lang_fre,
        "spa" to R.string.player_subs_lang_spa, "ita" to R.string.player_subs_lang_ita,
    )

    fun build(ctx: Context, scope: CoroutineScope, api: PlayerApi, itemId: String, defaultLang: String, onAdded: () -> Unit): View {
        val col = PanelRows.column(ctx)
        val p = PanelRows.dp(ctx, 16)

        val spinner = Spinner(ctx).apply {
            id = R.id.subs_lang
            contentDescription = ctx.getString(R.string.player_subs_language)
            adapter = object : ArrayAdapter<String>(ctx, android.R.layout.simple_spinner_item, LANGS.map { ctx.getString(LANG_NAMES.getValue(it)) }) {
                override fun getView(position: Int, convertView: View?, parent: ViewGroup) = style(super.getView(position, convertView, parent))
                override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup) = style(super.getDropDownView(position, convertView, parent))
                private fun style(v: View) = v.also { (it as? TextView)?.setTextColor(ContextCompat.getColor(ctx, android.R.color.white)) }
            }
            setSelection(LANGS.indexOf(defaultLang).coerceAtLeast(0))
        }
        val go = Button(ctx).apply {
            id = R.id.subs_go
            text = ctx.getString(R.string.player_subs_button)
        }
        col.addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(p, PanelRows.dp(ctx, 8), p, PanelRows.dp(ctx, 4))
            addView(spinner, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(go, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        })
        val msg = TextView(ctx).apply {
            id = R.id.subs_msg
            visibility = View.GONE
            setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(p, PanelRows.dp(ctx, 4), p, PanelRows.dp(ctx, 8))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        col.addView(msg)
        val results = PanelRows.column(ctx).apply { id = R.id.subs_results }
        col.addView(results)

        var busy = false
        fun setBusy(b: Boolean) {
            busy = b
            go.isEnabled = !b
            for (i in 0 until results.childCount) results.getChildAt(i).isEnabled = !b
        }
        fun say(text: String?) {
            msg.text = text ?: ""
            msg.visibility = if (text == null) View.GONE else View.VISIBLE
        }

        fun row(r: SubResult): View {
            val detail = if (r.downloads > 0) ctx.getString(R.string.player_subs_downloads, r.provider, r.downloads) else r.provider
            return PanelRows.item(ctx, r.name, { download(ctx, scope, api, itemId, r, ::setBusy, ::say, onAdded) { busy } }, icon = R.drawable.ic_player_search, detail = detail)
        }

        go.setOnClickListener {
            if (busy) return@setOnClickListener
            val lang = LANGS[spinner.selectedItemPosition.coerceIn(0, LANGS.lastIndex)]
            setBusy(true)
            say(null)
            results.removeAllViews()
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { api.searchSubtitles(itemId, lang) }.getOrElse { ApiResult.Err(0, null) } }
                when (r) {
                    is ApiResult.Ok -> if (r.value.isEmpty()) say(ctx.getString(R.string.player_subs_not_found)) else r.value.forEach { results.addView(row(it)) }
                    is ApiResult.Err -> say(ctx.getString(if (r.code == 403) R.string.player_subs_not_allowed else R.string.player_subs_provider_down))
                }
                setBusy(false)
            }
        }
        return col
    }

    /**
     * Whether a subtitle added from [panel] (searched for [searchedId]) still concerns playback: the panel is still the open one
     * ([openPanel]), the title on show is still [playingId] and no cast took over; otherwise the stream is left alone.
     */
    fun addedApplies(openPanel: View?, panel: View, searchedId: String, playingId: String, casting: Boolean): Boolean =
        openPanel === panel && searchedId == playingId && !casting

    private fun download(
        ctx: Context, scope: CoroutineScope, api: PlayerApi, itemId: String, r: SubResult,
        setBusy: (Boolean) -> Unit, say: (String?) -> Unit, onAdded: () -> Unit, busy: () -> Boolean,
    ) {
        if (busy()) return
        setBusy(true)
        say(null)
        scope.launch {
            val res = withContext(Dispatchers.IO) { runCatching { api.downloadSubtitle(itemId, r.id) }.getOrElse { ApiResult.Err(0, null) } }
            setBusy(false)
            when (res) {
                is ApiResult.Ok -> onAdded()
                is ApiResult.Err -> say(ctx.getString(R.string.player_subs_download_failed))
            }
        }
    }
}
