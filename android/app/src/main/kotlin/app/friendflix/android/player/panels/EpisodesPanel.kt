// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.graphics.Rect
import android.graphics.Typeface
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.content.ContextCompat
import app.friendflix.android.R
import app.friendflix.android.player.Episode
import app.friendflix.android.player.ImageLoader
import app.friendflix.android.player.PlayerApi
import app.friendflix.android.player.Season
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToLong

/** What the Episodes panel needs from the playing title: the series, the season it is in and the playing episode. */
data class EpisodesSource(
    val api: PlayerApi,
    val images: ImageLoader,
    val seriesId: String,
    /** the playing episode's season number (null = unknown: the first season is shown) */
    val season: Int?,
    val currentId: String,
)

/**
 * The web player's *Episodes* panel (EpisodesPanel.svelte): season tabs (the playing episode's season preselected, else the first;
 * a series without seasons lists all its episodes), then one row per episode with its code (`S1:E2`), name, run time and progress,
 * the playing one marked (with its still, "Now playing"). A tap calls [build]'s `onPick` with the episode id. Seasons and episodes
 * are kept in a [Cache] (per series, while the player lives); a failed request shows the web's text in the panel.
 */
object EpisodesPanel {
    /** seasons / episodes stay cached while the player hops from episode to episode (web module-level maps) */
    class Cache {
        internal val seasons = HashMap<String, List<Season>>()
        internal val episodes = HashMap<String, List<Episode>>()
    }

    /** the Episodes button: an episode of a series, streamed (never for a download) */
    fun offered(type: String?, seriesId: String?, offline: Boolean): Boolean = !offline && type == "Episode" && seriesId != null

    fun build(
        ctx: Context,
        scope: CoroutineScope,
        api: PlayerApi,
        images: ImageLoader,
        seriesId: String,
        currentSeason: Int?,
        currentId: String,
        cache: Cache = Cache(),
        onPick: (String) -> Unit,
    ): View {
        val col = PanelRows.column(ctx)
        val heading = PanelRows.header(ctx, "").apply { visibility = View.GONE }
        col.addView(heading)
        val tabs = LinearLayout(ctx).apply {
            id = R.id.episodes_seasons
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
            val p = PanelRows.dp(ctx, 12)
            setPadding(p, PanelRows.dp(ctx, 8), p, PanelRows.dp(ctx, 4))
        }
        col.addView(HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            contentDescription = ctx.getString(R.string.player_episodes_season)
            addView(tabs)
        })
        val msg = TextView(ctx).apply {
            id = R.id.episodes_msg
            setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            val p = PanelRows.dp(ctx, 16)
            setPadding(p, p, p, p)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        col.addView(msg)
        val list = PanelRows.column(ctx).apply { id = R.id.episodes_list }
        col.addView(list)

        fun say(text: Int?) {
            msg.text = text?.let(ctx::getString) ?: ""
            msg.visibility = if (text == null) View.GONE else View.VISIBLE
        }

        var placed = false
        fun show(eps: List<Episode>) {
            list.removeAllViews()
            if (eps.isEmpty()) { say(R.string.player_episodes_none); return }
            say(null)
            var cur: View? = null
            for (e in eps) {
                val row = row(ctx, list, e, e.id == currentId, images, scope, onPick)
                if (e.id == currentId) cur = row
                list.addView(row)
            }
            // once: the playing episode is brought into view
            val c = cur ?: return
            if (placed) return
            placed = true
            c.post { c.requestRectangleOnScreen(Rect(0, 0, c.width, c.height), true) }
        }

        var seq = 0
        fun loadEpisodes(seasonId: String?) {
            val my = ++seq
            val key = "$seriesId:${seasonId.orEmpty()}"
            cache.episodes[key]?.let { show(it); return }
            list.removeAllViews()
            say(R.string.player_episodes_loading)
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { api.episodes(seriesId, seasonId) }.getOrNull() }
                if (my != seq) return@launch
                if (r == null) { say(R.string.player_episodes_failed); return@launch }
                cache.episodes[key] = r
                show(r)
            }
        }

        fun showSeasons(seasons: List<Season>) {
            if (seasons.isEmpty()) { loadEpisodes(null); return } // no seasons (flat series): all episodes
            val start = seasons.firstOrNull { currentSeason != null && it.index == currentSeason } ?: seasons[0]
            if (seasons.size == 1) {
                heading.text = seasons[0].name
                heading.visibility = View.VISIBLE
            } else {
                tabs.visibility = View.VISIBLE
                for (s in seasons) {
                    tabs.addView(tab(ctx, s.name) { v ->
                        for (i in 0 until tabs.childCount) select(ctx, tabs.getChildAt(i) as TextView, tabs.getChildAt(i) === v)
                        loadEpisodes(s.id)
                    }.also { select(ctx, it, s === start) })
                }
            }
            loadEpisodes(start.id)
        }

        val hit = cache.seasons[seriesId]
        if (hit != null) {
            showSeasons(hit)
        } else {
            say(R.string.player_episodes_loading)
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { api.seasons(seriesId) }.getOrNull() }
                if (r != null) cache.seasons[seriesId] = r
                showSeasons(r.orEmpty()) // failed: like a series without seasons (web)
            }
        }
        return col
    }

    /** "52 min", "1 h 5 min" (web `fmtDuration` of the rounded minutes); null without a run time */
    fun runtime(ctx: Context, ticks: Long): String? {
        val m = (ticks / TICKS_PER_MINUTE).roundToLong().toInt()
        if (m <= 0) return null
        val h = m / 60
        val rest = m % 60
        return when {
            h == 0 -> ctx.getString(R.string.player_minutes, m)
            rest == 0 -> ctx.getString(R.string.player_duration_h, h)
            else -> ctx.getString(R.string.player_duration_hm, h, rest)
        }
    }

    /** watched share in percent: 100 once played (web `pct`) */
    fun percent(e: Episode): Int = when {
        e.played -> 100
        e.runtimeTicks > 0 && e.positionTicks > 0 -> (e.positionTicks * 100 / e.runtimeTicks).toInt().coerceIn(0, 100)
        else -> 0
    }

    private fun row(
        ctx: Context, parent: ViewGroup, e: Episode, cur: Boolean, images: ImageLoader, scope: CoroutineScope, onPick: (String) -> Unit,
    ): View {
        val v = LayoutInflater.from(ctx).inflate(R.layout.item_player_episode, parent, false)
        v.findViewById<TextView>(R.id.ep_code).text = when {
            e.season != null && e.episode != null -> ctx.getString(R.string.player_episode_code, e.season, e.episode)
            e.episode != null -> e.episode.toString()
            else -> ""
        }
        v.findViewById<TextView>(R.id.ep_name).text = e.name
        val time = runtime(ctx, e.runtimeTicks)
        val detail = if (cur) listOfNotNull(ctx.getString(R.string.player_episodes_playing), time).joinToString(" · ") else time
        v.findViewById<TextView>(R.id.ep_detail).apply {
            text = detail.orEmpty()
            visibility = if (detail != null) View.VISIBLE else View.GONE
            if (cur) setTextColor(ContextCompat.getColor(ctx, android.R.color.white))
        }
        val pct = percent(e)
        v.findViewById<ProgressBar>(R.id.ep_progress).apply {
            progress = pct
            visibility = if (pct > 0) View.VISIBLE else View.GONE
        }
        v.background = PanelRows.selectable(ctx)
        if (cur) {
            v.isSelected = true
            v.background = ContextCompat.getDrawable(ctx, R.drawable.player_episode_current)
            v.findViewById<View>(R.id.ep_thumb_box).visibility = View.VISIBLE
            if (e.image != null) images.into(v.findViewById<ImageView>(R.id.ep_thumb), e.image, PanelRows.dp(ctx, THUMB_DP), scope)
        }
        v.setOnClickListener { onPick(e.id) }
        return v
    }

    private fun tab(ctx: Context, name: String, onClick: (View) -> Unit): TextView = TextView(ctx).apply {
        text = name
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        minHeight = PanelRows.dp(ctx, 44)
        gravity = android.view.Gravity.CENTER
        val p = PanelRows.dp(ctx, 14)
        setPadding(p, 0, p, 0)
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick(it) }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            .apply { marginEnd = PanelRows.dp(ctx, 4) }
    }

    private fun select(ctx: Context, t: TextView, on: Boolean) {
        t.isSelected = on
        t.setTextColor(ContextCompat.getColor(ctx, if (on) android.R.color.white else R.color.player_muted))
        t.setTypeface(null, if (on) Typeface.BOLD else Typeface.NORMAL)
        t.background = if (on) ContextCompat.getDrawable(ctx, R.drawable.player_episode_current) else PanelRows.selectable(ctx)
    }

    private const val TICKS_PER_MINUTE = 600_000_000.0
    private const val THUMB_DP = 128
}
