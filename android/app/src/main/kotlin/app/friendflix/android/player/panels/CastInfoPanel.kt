// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.graphics.Typeface
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import app.friendflix.android.R
import app.friendflix.android.player.CastInfo
import app.friendflix.android.player.ImageLoader
import app.friendflix.android.player.Person
import app.friendflix.android.player.PlayerApi
import app.friendflix.android.player.Title
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

/**
 * The web player's *Cast & info* panel (CastInfoPanel.svelte): the title's name with year, age rating and score, then its cast,
 * guest stars, directors, writers and creators (portrait, name, "as role"; only the non-empty ones), studios and genres as text.
 * A person opens their other titles of the library in the same panel (a back row returns); a title there calls [onOpenTitle].
 * Requests run on the IO dispatcher from [scope]; a failed one shows the web's text in the panel (playback is not touched).
 */
object CastInfoPanel {
    fun build(
        ctx: Context,
        scope: CoroutineScope,
        api: PlayerApi,
        images: ImageLoader?,
        itemId: String,
        onOpenTitle: (String) -> Unit,
    ): View {
        val content = PanelRows.column(ctx).apply { id = R.id.info_content }
        var info: CastInfo? = null
        var seq = 0 // a person's titles of a sheet left meanwhile never replace the one on show

        fun say(text: Int) {
            content.removeAllViews()
            content.addView(status(ctx, text))
        }

        fun portrait(row: View, name: String, image: String?) {
            row.findViewById<TextView>(R.id.pi_initials).text = initials(name)
            if (image != null && images != null) {
                row.findViewById<TextView>(R.id.pi_initials).visibility = View.GONE
                images.into(row.findViewById<ImageView>(R.id.pi_image), image, PanelRows.dp(ctx, PORTRAIT_DP), scope)
            }
        }

        fun row(name: String, role: String?, image: String?, description: String, onClick: () -> Unit): View =
            LayoutInflater.from(ctx).inflate(R.layout.item_player_person, content, false).also { v ->
                v.findViewById<TextView>(R.id.pi_name).text = name
                v.findViewById<TextView>(R.id.pi_role).apply {
                    text = role.orEmpty()
                    visibility = if (role.isNullOrEmpty()) View.GONE else View.VISIBLE
                }
                portrait(v, name, image)
                v.contentDescription = description
                v.background = PanelRows.selectable(ctx)
                v.setOnClickListener { onClick() }
            }

        lateinit var showCast: () -> Unit

        fun showPerson(p: Person) {
            val my = ++seq
            content.removeAllViews()
            content.addView(PanelRows.item(ctx, ctx.getString(R.string.player_info_person_back), { seq++; showCast() }, id = R.id.info_back, icon = R.drawable.ic_player_back))
            content.addView(PanelRows.header(ctx, p.name))
            if (!p.role.isNullOrEmpty()) content.addView(PanelRows.note(ctx, ctx.getString(R.string.player_info_person_role, p.role)))
            content.addView(PanelRows.header(ctx, ctx.getString(R.string.player_info_person_more, p.name)))
            val msg = status(ctx, R.string.player_info_person_loading).also { content.addView(it) }
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { api.personTitles(p.id) }.getOrNull() }
                if (my != seq) return@launch
                if (r == null) { msg.text = ctx.getString(R.string.player_info_person_failed); return@launch }
                val others: List<Title> = r.filter { it.id != itemId }.take(MAX_TITLES)
                if (others.isEmpty()) { msg.text = ctx.getString(R.string.player_info_person_none); return@launch }
                content.removeView(msg)
                for (t in others) {
                    val label = if (t.year != null) "${t.name} (${t.year})" else t.name
                    content.addView(row(t.name, t.year?.toString(), t.image, label) { onOpenTitle(t.id) }.also {
                        it.findViewById<TextView>(R.id.pi_name).text = label
                        it.findViewById<TextView>(R.id.pi_role).visibility = View.GONE
                    })
                }
            }
        }

        fun section(heading: Int, people: List<Person>) {
            if (people.isEmpty()) return
            content.addView(PanelRows.header(ctx, ctx.getString(heading)))
            for (p in people) {
                content.addView(row(p.name, p.role?.takeIf { it.isNotEmpty() }?.let { ctx.getString(R.string.player_info_as, it) }, p.image,
                    ctx.getString(R.string.player_info_person, p.name)) { showPerson(p) })
            }
        }

        showCast = {
            val c = info!!
            content.removeAllViews()
            content.addView(TextView(ctx).apply {
                text = c.name
                setTextColor(ContextCompat.getColor(ctx, android.R.color.white))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                setTypeface(typeface, Typeface.BOLD)
                val p = PanelRows.dp(ctx, 16)
                setPadding(p, PanelRows.dp(ctx, 12), p, 0)
            })
            val facts = listOfNotNull(c.year?.toString(), c.rating, c.communityRating?.takeIf { it > 0 }?.let { "★ " + String.format(Locale.getDefault(), "%.1f", it) })
            if (facts.isNotEmpty()) content.addView(PanelRows.note(ctx, facts.joinToString(" · ")))
            section(R.string.player_info_cast, c.cast)
            section(R.string.player_info_guests, c.guests)
            if (c.cast.isEmpty() && c.guests.isEmpty()) content.addView(PanelRows.note(ctx, ctx.getString(R.string.player_info_none)))
            section(R.string.player_info_directors, c.directors)
            section(R.string.player_info_writers, c.writers)
            section(R.string.player_info_creators, c.creators)
            fun fact(heading: Int, values: List<String>) {
                if (values.isEmpty()) return
                content.addView(PanelRows.header(ctx, ctx.getString(heading)))
                content.addView(PanelRows.note(ctx, values.joinToString(", ")))
            }
            fact(R.string.player_info_studio, c.studios)
            fact(R.string.player_info_genres, c.genres)
        }

        say(R.string.player_info_loading)
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { api.castInfo(itemId) }.getOrNull() }
            if (r == null) { say(R.string.player_info_failed); return@launch }
            info = r
            showCast()
        }
        return content
    }

    private fun status(ctx: Context, text: Int): TextView = TextView(ctx).apply {
        this.text = ctx.getString(text)
        setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        val p = PanelRows.dp(ctx, 16)
        setPadding(p, p, p, p)
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }

    private fun initials(name: String): String =
        name.split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2).joinToString("") { it.substring(0, 1).uppercase(Locale.getDefault()) }

    private const val PORTRAIT_DP = 44
    private const val MAX_TITLES = 12
}
