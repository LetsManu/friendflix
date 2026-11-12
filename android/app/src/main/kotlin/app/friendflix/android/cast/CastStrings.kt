// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import android.content.Context
import app.friendflix.android.R
import org.json.JSONArray
import org.json.JSONObject

/** The own receiver's TV texts in the app's language (engine.ts `receiverStrings`): what the player screen and the hub both send. */
fun castReceiverStrings(context: Context): JSONObject = JSONObject()
    .put("next", context.getString(R.string.player_next))
    .put("upNext", context.getString(R.string.cast_up_next, "{label}"))
    .put("watchCredits", context.getString(R.string.player_watch_credits))
    .put("startsIn", JSONArray((1..CastController.COUNTDOWN_SECONDS).map { context.resources.getQuantityString(R.plurals.cast_starts_in, it, it) }))
    .put("stillTitle", context.getString(R.string.player_still_title))
    .put("stillText", context.getString(R.string.player_still_text, "{ep}"))
    .put("keepWatching", context.getString(R.string.player_keep_watching))
    .put("skip", JSONObject().put("intro", context.getString(R.string.player_skip_intro)).put("recap", context.getString(R.string.player_skip_recap)))
    .put("loading", context.getString(R.string.cast_loading))
    .put("stall", context.getString(R.string.cast_stall))
    .put("paused", context.getString(R.string.cast_paused))
    .put("now", context.getString(R.string.cast_now))
    .put("live", context.getString(R.string.cast_live))
