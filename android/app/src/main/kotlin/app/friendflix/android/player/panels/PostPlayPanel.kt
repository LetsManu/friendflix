// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.graphics.Typeface
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import app.friendflix.android.R
import app.friendflix.android.player.ImageLoader
import app.friendflix.android.player.PlayerApi
import app.friendflix.android.player.Players
import app.friendflix.android.player.Title
import kotlinx.coroutines.CoroutineScope
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * The web's post-play screen (PostPlay.svelte, lib/postplay.ts) as a player panel: "Just watched · title", the headline of the
 * answer's `state`, the next step (*Play* on the next part / the skipped episode / the sequel: [onPlay], never started by itself),
 * then each row of `rows[]` as a titled poster row. A title opens its page in the app ([onOpenTitle]); an episode plays ([onPlay]).
 * The anonymous counters of `POST /api/postplay/event` are the web's: `shown` once, `play` / `click` with the row kind, `dismiss`
 * when it is closed without either ([closed]). They leave in order on the report thread; a failure is ignored.
 */
object PostPlayPanel {
    private val PLAYABLE = setOf("Movie", "Episode")
    private val STATES = setOf("next", "movie_end", "series_finished", "caught_up", "gap")

    /** per screen: whether a title was played / opened from it (then its close is no dismiss) */
    private class State(val dismiss: () -> Unit) { var acted = false }

    fun build(
        ctx: Context,
        scope: CoroutineScope,
        api: PlayerApi,
        images: ImageLoader?,
        data: JSONObject,
        onPlay: (String) -> Unit,
        onOpenTitle: (String) -> Unit,
        spoilerProtection: Boolean = false,
        onBack: () -> Unit = {},
    ): View {
        val content = PanelRows.column(ctx).apply { id = R.id.postplay_content }
        fun send(body: JSONObject) { Players.reports.execute { api.postplayEvent(body) } }
        val state = State { send(JSONObject().put("type", "dismiss")) }
        content.setTag(R.id.postplay_content, state)

        val st = data.optString("state")
        val current = data.optJSONObject("current") ?: JSONObject()
        val title = label(current)
        val rows = objects(data.optJSONArray("rows")).filter { objects(it.optJSONArray("items")).isNotEmpty() }
        val next = data.optJSONObject("next")?.takeIf { st == "next" || st == "gap" }

        fun act(type: String, row: String, then: () -> Unit) {
            state.acted = true
            send(JSONObject().put("type", type).put("row", row))
            then()
        }

        content.addView(PanelRows.note(ctx, ctx.getString(R.string.player_postplay_just_watched, title)))
        content.addView(TextView(ctx).apply {
            id = R.id.postplay_head
            text = headline(ctx, st, current, next, rows)
            setTextColor(ContextCompat.getColor(ctx, android.R.color.white))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            setTypeface(typeface, Typeface.BOLD)
            val p = PanelRows.dp(ctx, 16)
            setPadding(p, 0, p, PanelRows.dp(ctx, 4))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        })
        when (st) {
            "caught_up" -> {
                val air = str(data, "nextAirDate")?.let(::date)
                val tail = if (air != null) ctx.getString(R.string.player_postplay_sub_next_air, air) else ctx.getString(R.string.player_postplay_sub_no_date)
                content.addView(PanelRows.note(ctx, ctx.getString(R.string.player_postplay_sub_caught_up, title) + " " + tail))
            }
            "gap" -> content.addView(PanelRows.note(ctx, ctx.getString(R.string.player_postplay_sub_gap, title)))
        }

        // the next step: the next part / the skipped episode, else a finished series' sequel
        val step = next ?: data.optJSONObject("sequel")?.takeIf { st == "series_finished" }
        val stepId = step?.optString("id")?.takeIf { it.isNotEmpty() }
        if (step != null && stepId != null) {
            val text = if (st == "gap") ctx.getString(R.string.player_postplay_jump_back, step.optString("indexNumber"))
            else ctx.getString(R.string.player_postplay_play_title, step.optString("name"))
            content.addView(button(ctx, text, R.id.postplay_play, R.drawable.ic_player_play) {
                // a sequel that is a whole series has no stream of its own: its page opens instead
                act("play", "continuation") { if (str(step, "type") in PLAYABLE) onPlay(stepId) else onOpenTitle(stepId) }
            })
        }

        val box = PanelRows.column(ctx).apply { id = R.id.postplay_rows }
        for (r in rows) {
            val kind = r.optString("kind")
            val row = PanelRows.column(ctx)
            row.addView(PanelRows.header(ctx, rowTitle(ctx, r)))
            rowWhy(ctx, r)?.let { row.addView(PanelRows.note(ctx, it)) }
            val tiles = strip(ctx, row)
            for (i in objects(r.optJSONArray("items"))) {
                val id = i.optString("id").takeIf { it.isNotEmpty() } ?: continue
                val episode = str(i, "type") == "Episode"
                val name = if (episode) ctx.getString(R.string.player_postplay_episode, i.optString("parentIndexNumber"), i.optString("indexNumber"), i.optString("name")) else i.optString("name")
                val spoiler = episode && spoilerProtection && !i.optBoolean("played", false) && i.optLong("positionTicks", 0) <= 0
                tiles.addView(tile(ctx, scope, tiles, images, name, if (spoiler) null else PlayerApi.imageOf(i, POSTER_PX), spoiler) {
                    if (episode) act("play", kind) { onPlay(id) } else act("click", kind) { onOpenTitle(id) }
                })
            }
            box.addView(row)
        }
        content.addView(box)
        if (data.optBoolean("suggestions", true) && rows.isEmpty() && next == null) {
            content.addView(PanelRows.note(ctx, ctx.getString(R.string.player_postplay_empty)).apply { id = R.id.postplay_empty })
        }
        content.addView(button(ctx, ctx.getString(R.string.player_postplay_back), R.id.postplay_back, R.drawable.ic_player_back) { onBack() })

        if (st in STATES) send(JSONObject().put("type", "shown").put("state", st))
        return content
    }

    /** The screen [build] made was closed: a `dismiss` unless a title was played or opened from it (once). */
    fun closed(view: View) {
        val s = view.getTag(R.id.postplay_content) as? State ?: return
        if (s.acted) return
        s.acted = true
        s.dismiss()
    }

    /** "More like this" at the end of a film without post-play (watch page `.more`): the titles; a tap opens the title's page. */
    fun more(ctx: Context, scope: CoroutineScope, images: ImageLoader?, titles: List<Title>, onOpenTitle: (String) -> Unit): View {
        val content = PanelRows.column(ctx)
        val tiles = strip(ctx, content).apply { id = R.id.postplay_similar }
        for (t in titles) tiles.addView(tile(ctx, scope, tiles, images, t.name, t.image, false) { onOpenTitle(t.id) })
        return content
    }

    /** a horizontal, scrolling row of tiles inside [parent] */
    private fun strip(ctx: Context, parent: ViewGroup): LinearLayout {
        val tiles = LinearLayout(ctx).apply {
            id = R.id.postplay_row_items
            orientation = LinearLayout.HORIZONTAL
            val p = PanelRows.dp(ctx, 16)
            setPadding(p, PanelRows.dp(ctx, 4), p, PanelRows.dp(ctx, 8))
        }
        parent.addView(HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(tiles, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return tiles
    }

    private fun tile(
        ctx: Context, scope: CoroutineScope, parent: ViewGroup, images: ImageLoader?, name: String, image: String?, spoiler: Boolean, onClick: () -> Unit,
    ): View = LayoutInflater.from(ctx).inflate(R.layout.item_player_poster, parent, false).also { v ->
        v.findViewById<TextView>(R.id.pp_name).text = name
        val img = v.findViewById<ImageView>(R.id.pp_image)
        if (spoiler) {
            img.contentDescription = ctx.getString(R.string.player_postplay_spoiler)
            img.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        if (image != null && images != null) images.into(img, image, PanelRows.dp(ctx, POSTER_DP), scope)
        v.contentDescription = name
        v.background = PanelRows.selectable(ctx)
        v.setOnClickListener { onClick() }
    }

    private fun button(ctx: Context, text: String, id: Int, icon: Int, onClick: () -> Unit): Button =
        Button(ctx, null, android.R.attr.buttonBarButtonStyle).apply {
            this.id = id
            this.text = text
            isAllCaps = false
            gravity = android.view.Gravity.CENTER_VERTICAL or android.view.Gravity.START
            setCompoundDrawablesRelativeWithIntrinsicBounds(icon, 0, 0, 0)
            compoundDrawablePadding = PanelRows.dp(ctx, 12)
            val p = PanelRows.dp(ctx, 16)
            setPadding(p, 0, p, 0)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setOnClickListener { onClick() }
        }

    /** web `label`: an episode is named by its series */
    private fun label(i: JSONObject): String = if (str(i, "type") == "Episode" && str(i, "seriesName") != null) i.optString("seriesName") else i.optString("name")

    /** web lib/postplay.ts `headline` */
    private fun headline(ctx: Context, state: String, current: JSONObject, next: JSONObject?, rows: List<JSONObject>): String {
        val title = label(current)
        return when (state) {
            "caught_up" -> ctx.getString(R.string.player_postplay_head_caught_up)
            "series_finished" -> ctx.getString(R.string.player_postplay_head_series_finished, title)
            "gap" -> ctx.getString(R.string.player_postplay_head_gap, next?.optString("indexNumber").orEmpty())
            "next" -> {
                if (next == null) return ctx.getString(R.string.player_postplay_head_movie_end, title)
                val name = rows.firstOrNull { it.optString("kind") == "continuation" }?.let { str(it, "title") }
                if (str(next, "type") == "Episode" || name == null) ctx.getString(R.string.player_postplay_head_next_episode, next.optString("name"))
                else ctx.getString(R.string.player_postplay_head_next_part, name, next.optString("name"))
            }
            else -> ctx.getString(R.string.player_postplay_head_movie_end, title)
        }
    }

    /** web `rowTitle` */
    private fun rowTitle(ctx: Context, r: JSONObject): String {
        val title = r.optString("title")
        return when (r.optString("kind")) {
            "continuation" -> ctx.getString(R.string.player_postplay_row_continuation)
            "transition" -> ctx.getString(R.string.player_postplay_row_transition, title)
            "universe" -> ctx.getString(R.string.player_postplay_row_universe, title)
            "because" -> ctx.getString(R.string.player_postplay_row_because, seed(r) ?: title)
            "friends" -> ctx.getString(R.string.player_postplay_row_friends)
            else -> ctx.getString(R.string.player_postplay_row_taste)
        }
    }

    /** web `rowWhy` (null: none) */
    private fun rowWhy(ctx: Context, r: JSONObject): String? {
        val kind = r.optString("kind")
        if (kind == "friends") return ctx.getString(R.string.player_postplay_why_friends)
        val s = seed(r) ?: return null
        return if (kind != "because" && kind != "continuation") ctx.getString(R.string.player_postplay_why_seed, s) else null
    }

    private fun seed(r: JSONObject): String? = r.optJSONObject("reason")?.optJSONObject("seed")?.let { str(it, "name") }

    private fun date(iso: String): String? = try {
        LocalDate.parse(iso.take(ISO_DATE_LENGTH)).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    } catch (_: RuntimeException) {
        null
    }

    private fun str(o: JSONObject, k: String): String? = if (!o.has(k) || o.isNull(k)) null else o.optString(k).takeIf { it.isNotEmpty() }

    private fun objects(a: JSONArray?): List<JSONObject> = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }

    private const val POSTER_DP = 112
    private const val POSTER_PX = 300
    private const val ISO_DATE_LENGTH = 10
}
