// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import app.friendflix.android.R
import app.friendflix.android.player.SPEEDS
import java.util.Locale

/**
 * What the More panel offers. [showSpeed] false while casting; [qualities] the quality rungs (label, bit/s) or null when quality
 * is not offered (offline, casting), [quality] the chosen one (0 = automatic); [sleepMinutes] the running minute timer (0 = none),
 * [sleepLeftMs] its time left; [cast] null = no cast row, else whether a cast runs ("Playing on TV").
 */
data class MoreState(
    val speed: Float,
    val showSpeed: Boolean,
    val qualities: List<Pair<String, Long>>?,
    val quality: Long,
    val sleepMinutes: Int,
    val sleepAfterEpisode: Boolean,
    val sleepLeftMs: Long?,
    val canLock: Boolean,
    val canPip: Boolean,
    val cast: Boolean?,
)

interface MoreActions {
    fun speed(rate: Float)
    fun quality(bps: Long)
    /** a minute timer; 0 = off */
    fun sleep(minutes: Int)
    fun sleepAfterEpisode()
    fun lock()
    fun pip()
    fun cast()
}

/**
 * The web player's More (⋯) menu: Speed, Quality and Sleep timer open their lists in the same panel (with a row back to More),
 * then Lock controls, Picture-in-picture and Play on TV / Playing on TV.
 */
object MorePanel {
    val SLEEP_MINUTES = listOf(15, 30, 45, 60)

    fun build(ctx: Context, state: MoreState, actions: MoreActions): View {
        val box = FrameLayout(ctx)
        lateinit var main: View
        fun open(list: View) { box.removeAllViews(); box.addView(list) }
        fun backToMain() = open(main)
        fun sub(title: Int, rows: (LinearLayout) -> Unit): View = PanelRows.column(ctx).also { col ->
            col.addView(PanelRows.item(ctx, "‹  " + ctx.getString(R.string.player_back_to_more), ::backToMain, id = R.id.more_back))
            col.addView(PanelRows.header(ctx, ctx.getString(title)))
            rows(col)
        }

        main = PanelRows.column(ctx).also { col ->
            if (state.showSpeed) {
                col.addView(PanelRows.item(
                    ctx, ctx.getString(R.string.player_speed), {
                        open(sub(R.string.player_speed) { l ->
                            for (r in SPEEDS) l.addView(PanelRows.item(ctx, speedLabel(ctx, r), { actions.speed(r) }, checked = r == state.speed))
                        })
                    },
                    id = R.id.more_speed, icon = R.drawable.ic_player_speed,
                    detail = if (state.speed != 1f) rate(ctx, state.speed) else null, chevron = true,
                ))
            }
            val qualities = state.qualities
            if (qualities != null) {
                val current = qualities.firstOrNull { it.second == state.quality }?.first ?: ctx.getString(R.string.player_quality_auto)
                col.addView(PanelRows.item(
                    ctx, ctx.getString(R.string.player_quality), {
                        open(sub(R.string.player_quality) { l ->
                            l.addView(PanelRows.item(ctx, ctx.getString(R.string.player_quality_auto), { actions.quality(0) }, checked = state.quality == 0L))
                            for ((label, bps) in qualities) l.addView(PanelRows.item(ctx, label, { actions.quality(bps) }, checked = state.quality == bps))
                        })
                    },
                    id = R.id.more_quality, icon = R.drawable.ic_player_quality, detail = current, chevron = true,
                ))
            }
            col.addView(PanelRows.item(
                ctx, ctx.getString(R.string.player_sleep), {
                    open(sub(R.string.player_sleep) { l ->
                        val minuteTimer = state.sleepLeftMs != null
                        l.addView(PanelRows.item(ctx, ctx.getString(R.string.player_off), { actions.sleep(0) }, checked = !minuteTimer && !state.sleepAfterEpisode))
                        for (m in SLEEP_MINUTES) {
                            val on = minuteTimer && state.sleepMinutes == m
                            l.addView(PanelRows.item(
                                ctx, ctx.getString(R.string.player_minutes, m), { actions.sleep(m) }, checked = on,
                                detail = if (on) "(" + clock(state.sleepLeftMs ?: 0) + ")" else null,
                            ))
                        }
                        l.addView(PanelRows.item(ctx, ctx.getString(R.string.player_sleep_after_episode_option), { actions.sleepAfterEpisode() }, checked = state.sleepAfterEpisode))
                    })
                },
                id = R.id.more_sleep, icon = R.drawable.ic_player_sleep,
                detail = sleepLeft(ctx, state.sleepLeftMs), detailId = R.id.more_sleep_left, chevron = true,
            ))
            if (state.canLock) col.addView(PanelRows.item(ctx, ctx.getString(R.string.player_lock), actions::lock, id = R.id.more_lock, icon = R.drawable.ic_player_lock))
            if (state.canPip) col.addView(PanelRows.item(ctx, ctx.getString(R.string.player_pip), actions::pip, id = R.id.more_pip, icon = R.drawable.ic_player_pip))
            state.cast?.let { casting ->
                col.addView(PanelRows.item(
                    ctx, ctx.getString(if (casting) R.string.player_cast_playing else R.string.player_cast), actions::cast,
                    id = R.id.more_cast, icon = R.drawable.ic_player_cast,
                ).apply { isActivated = casting })
            }
        }
        open(main)
        return box
    }

    /** "Sleep timer 12:34" while a minute timer runs, else empty */
    fun sleepLeft(ctx: Context, ms: Long?): String = if (ms == null) "" else ctx.getString(R.string.player_sleep_left, clock(ms))

    /** the speed list's label: "1× (Normal)" or "1.5×" (web speedLabel) */
    fun speedLabel(ctx: Context, r: Float): String = if (r == 1f) ctx.getString(R.string.player_speed_normal) else rate(ctx, r)

    /** "1.5×", "0.75×", "2×" (web player.speed.rate) */
    fun rate(ctx: Context, r: Float): String {
        val n = if (r == r.toInt().toFloat()) r.toInt().toString() else r.toString()
        return ctx.getString(R.string.player_speed_rate, n)
    }

    /** m:ss, or h:mm:ss from an hour (web fmtClock) */
    fun clock(ms: Long): String {
        val s = (ms + 999) / 1000
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec) else String.format(Locale.ROOT, "%d:%02d", m, sec)
    }
}
