// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.friendflix.android.shell.origin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private val Context.tvDataStore: DataStore<Preferences> by preferencesDataStore(name = "tv_settings")

/** What the Fire TV app remembers (DataStore `tv_settings`): the server, its sign-in origin and the server the first-run check ran for. */
class TvSettings(private val store: DataStore<Preferences>) {
    /** The server's origin as the start screen saved it, or null before the first successful check. */
    val serverOrigin: Flow<HttpUrl?> = store.data.map { it[SERVER_ORIGIN]?.toHttpUrlOrNull() }

    /** The server's sign-in page origin (`authOrigin` of /api/version) as last seen, or null when it names none. */
    val authOrigin: Flow<HttpUrl?> = store.data.map { it[AUTH_ORIGIN]?.toHttpUrlOrNull() }

    /** The origin the first-run playback check ran for, or null when it has not run since the server was set. */
    val probedOrigin: Flow<String?> = store.data.map { it[PROBED_ORIGIN] }

    /** A server chosen on the form: its origin and sign-in origin. The first-run check runs again for it, also for the same address. */
    suspend fun setServer(origin: HttpUrl, auth: HttpUrl?) {
        store.edit {
            it[SERVER_ORIGIN] = origin.origin()
            if (auth == null) it.remove(AUTH_ORIGIN) else it[AUTH_ORIGIN] = auth.origin()
            it.remove(PROBED_ORIGIN)
        }
    }

    /** The sign-in origin as the check at app start saw it (the server may have changed it). */
    suspend fun setAuthOrigin(auth: HttpUrl?) {
        store.edit { if (auth == null) it.remove(AUTH_ORIGIN) else it[AUTH_ORIGIN] = auth.origin() }
    }

    suspend fun setProbedOrigin(origin: String) { store.edit { it[PROBED_ORIGIN] = origin } }

    companion object {
        private val SERVER_ORIGIN = stringPreferencesKey("serverOrigin")
        private val AUTH_ORIGIN = stringPreferencesKey("authOrigin")
        private val PROBED_ORIGIN = stringPreferencesKey("probedOrigin")

        fun from(context: Context): TvSettings = TvSettings(context.applicationContext.tvDataStore)
    }
}
