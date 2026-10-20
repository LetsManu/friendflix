// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import android.media.audiofx.DynamicsProcessing
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.edit
import app.friendflix.android.R
import app.friendflix.android.player.panels.TracksPanel

/**
 * Clear voices / night mode on the player's audio session (web lib/player/audiofx.ts, spec §4) with
 * [DynamicsProcessing] (Android 9, API 28, and newer): the mode's [fxConfig] as pre-EQ (3 bands), a one-band multi-band
 * compressor, the limiter and the input gain. One effect at a time; a new session or mode releases the old one first.
 * [open] creates the effect (a seam for tests) and returns its release; a device that refuses the effect keeps playing without it.
 */
class AudioFxAttach(
    private val sdk: Int = Build.VERSION.SDK_INT,
    private val open: (Int, DynamicsProcessing.Config) -> () -> Unit = ::openEffect,
) {
    private var release: (() -> Unit)? = null
    private var session = 0
    private var mode = "off"

    fun supported(): Boolean = sdk >= Build.VERSION_CODES.P

    /** [mode] (off | voices | night | both) on [sessionId]; 0 = no session yet (nothing to attach to). */
    fun apply(sessionId: Int, mode: String) {
        if (!supported() || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
        if (sessionId == session && mode == this.mode && (release != null || fxConfig(mode) == null)) return
        release()
        if (sessionId == 0) return
        val cfg = config(mode) ?: return
        try {
            release = open(sessionId, cfg)
            session = sessionId
            this.mode = mode
        } catch (e: RuntimeException) {
            Log.w(TAG, "audio effect unavailable ${e.javaClass.simpleName}")
        }
    }

    fun release() {
        val r = release
        release = null
        session = 0
        mode = "off"
        try { r?.invoke() } catch (_: RuntimeException) { }
    }

    companion object {
        private const val TAG = "FFAudioFx"
        private const val CHANNELS = 2
        /** the compressor covers the whole range in one band */
        private const val FULL_RANGE_HZ = 20_000f
        /** knee widths of the web's DynamicsCompressor stages (not part of [FxParams]) */
        private const val VOICES_KNEE_DB = 12f
        private const val NIGHT_KNEE_DB = 18f
        private const val NOISE_GATE_DB = -90f

        /** the [DynamicsProcessing] configuration of [mode], or null for no processing */
        @RequiresApi(Build.VERSION_CODES.P)
        fun config(mode: String): DynamicsProcessing.Config? {
            val p = fxConfig(mode) ?: return null
            val eqBands = p.preEq.size.coerceAtLeast(1)
            val b = DynamicsProcessing.Config.Builder(
                DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, CHANNELS,
                p.preEq.isNotEmpty(), eqBands, p.compressor != null, 1, false, 1, p.limiter != null,
            )
            if (p.preEq.isNotEmpty()) {
                val eq = DynamicsProcessing.Eq(true, true, p.preEq.size)
                p.preEq.forEachIndexed { i, (hz, db) -> eq.setBand(i, DynamicsProcessing.EqBand(true, hz, db)) }
                b.setPreEqAllChannelsTo(eq)
            }
            p.compressor?.let { c ->
                val knee = if (mode == "voices") VOICES_KNEE_DB else NIGHT_KNEE_DB
                val mbc = DynamicsProcessing.Mbc(true, true, 1)
                mbc.setBand(0, DynamicsProcessing.MbcBand(true, FULL_RANGE_HZ, c.attackMs, c.releaseMs, c.ratio, c.thresholdDb, knee, NOISE_GATE_DB, 1f, 0f, 0f))
                b.setMbcAllChannelsTo(mbc)
            }
            p.limiter?.let { l -> b.setLimiterAllChannelsTo(DynamicsProcessing.Limiter(true, true, 0, l.attackMs, l.releaseMs, l.ratio, l.thresholdDb, 0f)) }
            b.setInputGainAllChannelsTo(p.gainDb)
            return b.build()
        }

        private fun openEffect(sessionId: Int, cfg: DynamicsProcessing.Config): () -> Unit {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return {}
            return started(DynamicsProcessing(0, sessionId, cfg), { it.enabled = true }, { it.release() })
        }

        /** [effect] switched on by [enable]; its release, or (when [enable] throws) released at once and the error passed on */
        internal fun <T> started(effect: T, enable: (T) -> Unit, release: (T) -> Unit): () -> Unit {
            try {
                enable(effect)
            } catch (e: RuntimeException) {
                release(effect)
                throw e
            }
            return { release(effect) }
        }
    }
}

/** The last sound mode per profile on this device (controller ruling R2): offline playback uses it. */
object FxStore {
    private const val FILE = "player_fx"

    fun load(ctx: Context, profileId: String): String =
        ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(key(profileId), null)?.takeIf(::valid) ?: "off"

    fun save(ctx: Context, profileId: String, mode: String) {
        if (!valid(mode)) return
        ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit { putString(key(profileId), mode) }
    }

    private fun key(profileId: String) = "mode:$profileId"
    private fun valid(mode: String) = mode == "off" || fxConfig(mode) != null
}

/** The toast of a switch flip (web scenes.audio.on / off): the switch that changed and its new state, null when none did. */
fun fxToggle(old: String, new: String): Pair<Int, Boolean>? {
    val (v0, n0) = TracksPanel.fxFlags(old)
    val (v1, n1) = TracksPanel.fxFlags(new)
    return when {
        v0 != v1 -> R.string.player_fx_voices to v1
        n0 != n1 -> R.string.player_fx_night to n1
        else -> null
    }
}

/** Why the sound switches are off (a string resource), or null: below Android 9, and while casting (ruling R2). */
fun fxDisabledReason(supported: Boolean, casting: Boolean): Int? = when {
    !supported -> R.string.player_fx_unsupported
    casting -> R.string.player_fx_casting
    else -> null
}
