// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import org.json.JSONObject
import java.io.File

/**
 * What the offline code remembers between runs (`filesDir/offline-state.json`):
 * - [lastProfileId]: the last active profile (from `/api/me` at every online check, and from the profile id of every play / download
 *   hand-over from the web UI). The offline list shows only its downloads, like the web's `lastProfileId`.
 * - [lastCheck]: the device time of the last successful online licence check.
 * - [maxSeen]: the highest device time the app has seen (start, offline list, playback); with [lastCheck] it guards against a clock that
 *   was turned back.
 */
class OfflineState(file: File, onWrite: () -> Unit = {}) {
    private val store = JsonFile(file, onWrite)
    private var profile: String?
    private var seen: Long
    private var checked: Long

    init {
        val o = store.read()
        profile = o?.takeUnless { it.isNull("lastProfileId") }?.optString("lastProfileId")?.takeIf { it.isNotEmpty() }
        seen = o?.optLong("maxSeen") ?: 0
        checked = o?.optLong("lastCheck") ?: 0
    }

    val lastProfileId: String? @Synchronized get() = profile
    val maxSeen: Long @Synchronized get() = seen
    val lastCheck: Long @Synchronized get() = checked

    @Synchronized
    fun setProfile(id: String) {
        if (id == profile) return
        profile = id
        save()
    }

    /** The app was used at [now]: the highest time seen only ever grows (until an online check vouches for the clock again). */
    @Synchronized
    fun bump(now: Long) {
        if (now <= seen) return
        seen = now
        save()
    }

    /** A successful online check at [now]: it renews the licences, so the clock guard starts over from this moment. */
    @Synchronized
    fun checkedAt(now: Long) {
        checked = now
        seen = now
        save()
    }

    /** Forgets everything (sign-out of this device / another server): no profile, no check, no time seen. */
    @Synchronized
    fun clear() {
        profile = null
        seen = 0
        checked = 0
        save()
    }

    fun flush() = store.flush()

    private fun save() = store.save(JSONObject().put("version", 1).put("lastProfileId", profile ?: JSONObject.NULL).put("maxSeen", seen).put("lastCheck", checked))
}
