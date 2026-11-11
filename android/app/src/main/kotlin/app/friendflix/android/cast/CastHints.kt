// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import android.content.Context
import androidx.core.content.edit

/** [CastHints] in a private preferences file: the public castIds only (never a token, URL or report token). */
class PrefsCastHints(context: Context) : CastHints {
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    override fun read(): CastHints.Hint? {
        val id = prefs.getString(KEY_ID, null)?.takeIf(CastIds::valid) ?: return null
        return CastHints.Hint(id, prefs.getString(KEY_NEXT, null)?.takeIf(CastIds::valid))
    }

    override fun write(h: CastHints.Hint) {
        prefs.edit { putString(KEY_ID, h.castId); if (h.next != null) putString(KEY_NEXT, h.next) else remove(KEY_NEXT) }
    }

    override fun clear() { prefs.edit { clear() } }

    private companion object {
        const val FILE = "ff_cast_hint"
        const val KEY_ID = "castId"
        const val KEY_NEXT = "next"
    }
}
