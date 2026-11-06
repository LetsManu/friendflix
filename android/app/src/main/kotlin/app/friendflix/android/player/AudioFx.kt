// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

/** A compressor / limiter stage. */
data class Comp(val thresholdDb: Float, val ratio: Float, val attackMs: Float, val releaseMs: Float)

/**
 * The processing of a sound mode (web lib/player/audiofx.ts `fxPlan`).
 * [preEq] = DynamicsProcessing bands as (cutoffHz, gainDb): low shelf up to 180 Hz, speech band to 4 kHz, high shelf to 20 kHz.
 */
data class FxParams(val preEq: List<Pair<Float, Float>>, val compressor: Comp?, val limiter: Comp?, val gainDb: Float)

private val VOICES_EQ = listOf(180f to -4f, 4000f to 6f, 20000f to -2f)
private val VOICES_COMP = Comp(-24f, 3f, 10f, 250f)
private val NIGHT_COMP = Comp(-42f, 8f, 4f, 300f)
private val NIGHT_LIMITER = Comp(-4f, 20f, 1f, 100f)

/** [mode] = off | voices | night | both; null = no processing. */
fun fxConfig(mode: String): FxParams? = when (mode) {
    "voices" -> FxParams(VOICES_EQ, VOICES_COMP, null, 1.94f)
    "night" -> FxParams(emptyList(), NIGHT_COMP, NIGHT_LIMITER, 6.85f)
    "both" -> FxParams(VOICES_EQ, NIGHT_COMP, NIGHT_LIMITER, 6.85f)
    else -> null
}
