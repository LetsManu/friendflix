// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player.panels

import android.content.Context
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.core.content.ContextCompat
import app.friendflix.android.R
import app.friendflix.android.player.AudioTrack

/**
 * What the Tracks panel shows: audio tracks (listed only when there is more than one; [audioIndex] null = the default track),
 * subtitles as (index, title) with [subIndex] null = off, *Find subtitles …* when [canSearch], and the sound mode [fxMode]
 * (`off | voices | night | both`); [fxDisabledReason] is a string resource explaining why the sound switches are off, or null.
 */
data class TracksState(
    val audio: List<AudioTrack>,
    val audioIndex: Int?,
    val subs: List<Pair<Int, String>>,
    val subIndex: Int?,
    val canSearch: Boolean,
    val fxMode: String,
    val fxDisabledReason: Int?,
)

interface TracksActions {
    fun audio(t: AudioTrack)
    fun subtitle(index: Int?)
    fun search()
    fun fx(mode: String)
}

/** The web player's "Audio and subtitles" menu: Audio, Subtitles (Off, Find subtitles …, tracks), Sound (Clear voices, Night mode). */
object TracksPanel {
    fun build(ctx: Context, state: TracksState, actions: TracksActions): View {
        val col = PanelRows.column(ctx)
        if (state.audio.size > 1) {
            col.addView(PanelRows.header(ctx, ctx.getString(R.string.player_audio), R.id.tracks_audio))
            val current = state.audioIndex ?: state.audio.firstOrNull { it.isDefault }?.index ?: state.audio.first().index
            for (t in state.audio) col.addView(PanelRows.item(ctx, t.title, { actions.audio(t) }, checked = t.index == current))
        }
        col.addView(PanelRows.header(ctx, ctx.getString(R.string.player_subtitles)))
        col.addView(PanelRows.item(ctx, ctx.getString(R.string.player_subtitles_off), { actions.subtitle(null) }, checked = state.subIndex == null))
        if (state.canSearch) {
            col.addView(PanelRows.item(ctx, ctx.getString(R.string.player_subs_search), { actions.search() }, id = R.id.tracks_search, icon = R.drawable.ic_player_search))
        }
        for ((index, title) in state.subs) col.addView(PanelRows.item(ctx, title, { actions.subtitle(index) }, checked = state.subIndex == index))

        col.addView(PanelRows.header(ctx, ctx.getString(R.string.player_sound)))
        val enabled = state.fxDisabledReason == null
        val (voicesOn, nightOn) = fxFlags(state.fxMode)
        lateinit var voices: SwitchCompat
        lateinit var night: SwitchCompat
        val changed = { actions.fx(fxMode(voices.isChecked, night.isChecked)) }
        voices = fxSwitch(ctx, R.id.tracks_fx_voices, voicesOn && enabled, enabled, changed)
        night = fxSwitch(ctx, R.id.tracks_fx_night, nightOn && enabled, enabled, changed)
        col.addView(fxRow(ctx, voices, R.string.player_fx_voices, R.string.player_fx_voices_hint))
        col.addView(fxRow(ctx, night, R.string.player_fx_night, R.string.player_fx_night_hint))
        state.fxDisabledReason?.let { col.addView(PanelRows.note(ctx, ctx.getString(it))) }
        return col
    }

    /** the sound mode of the two switches (web audiofx modes) */
    fun fxMode(voices: Boolean, night: Boolean): String = when {
        voices && night -> "both"
        voices -> "voices"
        night -> "night"
        else -> "off"
    }

    /** (clear voices, night mode) of a sound mode */
    fun fxFlags(mode: String): Pair<Boolean, Boolean> = (mode == "voices" || mode == "both") to (mode == "night" || mode == "both")

    private fun fxSwitch(ctx: Context, id: Int, on: Boolean, enabled: Boolean, changed: () -> Unit) = SwitchCompat(ctx).apply {
        this.id = id
        isChecked = on
        isEnabled = enabled
        setOnCheckedChangeListener { _, _ -> changed() }
    }

    /** a switch row: name and hint, the switch at the end; a tap anywhere on the row flips it */
    private fun fxRow(ctx: Context, switch: SwitchCompat, label: Int, hint: Int): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = PanelRows.dp(ctx, 56)
        val p = PanelRows.dp(ctx, 16)
        setPadding(p, PanelRows.dp(ctx, 4), p, PanelRows.dp(ctx, 4))
        val texts = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(ctx).apply {
                text = ctx.getString(label)
                setTextColor(ContextCompat.getColor(ctx, if (switch.isEnabled) android.R.color.white else R.color.player_muted))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            })
            addView(TextView(ctx).apply {
                text = ctx.getString(hint)
                setTextColor(ContextCompat.getColor(ctx, R.color.player_muted))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            })
        }
        addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(switch, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        // the switch carries the label for screen readers; the row only widens the tap target
        switch.contentDescription = ctx.getString(label)
        texts.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        if (switch.isEnabled) {
            background = PanelRows.selectable(ctx)
            setOnClickListener { switch.toggle() }
        }
    }
}
