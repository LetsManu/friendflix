// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.settings

import android.content.Context
import androidx.core.content.edit
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.friendflix.android.shell.origin
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

enum class StorageLocation { PHONE, SD }

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/**
 * App settings (DataStore). [castMirror] receives every stored CAST_RECEIVER_APP_ID too: the Cast framework's options provider runs
 * synchronously at its start and reads that mirror ([castReceiverAppIdNow]) instead of blocking on DataStore.
 */
class AppSettings(private val store: DataStore<Preferences>, private val castMirror: (String) -> Unit = {}) {
    val serverOrigin: Flow<HttpUrl?> = store.data.map { it[SERVER_ORIGIN]?.toHttpUrlOrNull() }
    /**
     * The server's sign-in page origin (`authOrigin` of /api/version) as last seen, or null: the one other origin the shell's WebView may
     * show in its main frame (never with the bridge or native cookies). Saved at setup, refreshed at every app start.
     */
    val authOrigin: Flow<HttpUrl?> = store.data.map { it[AUTH_ORIGIN]?.toHttpUrlOrNull() }
    val storage: Flow<StorageLocation> = store.data.map {
        StorageLocation.entries.firstOrNull { e -> e.name == it[STORAGE] } ?: StorageLocation.PHONE
    }
    val wifiOnly: Flow<Boolean> = store.data.map { it[WIFI_ONLY] ?: false }
    val backgroundAudio: Flow<Boolean> = store.data.map { it[BACKGROUND_AUDIO] ?: false }
    val notifyCategories: Flow<Set<String>> = store.data.map { it[NOTIFY_CATEGORIES] ?: emptySet() }
    /** The categories the user chose, or null while nothing was chosen yet (the notification poller then treats every category as on). */
    val notifyCategoriesChosen: Flow<Set<String>?> = store.data.map { it[NOTIFY_CATEGORIES] }
    /** The newest server notification id the poller has dealt with, for [origin] only (another server numbers its own); null = none yet. */
    fun notifyLastId(origin: String): Flow<Long?> = store.data.map { p -> p[NOTIFY_LAST_ID]?.takeIf { p[NOTIFY_LAST_ORIGIN] == origin } }
    /** The poller met a 401 and stays quiet until the app is opened again. */
    val notifyPaused: Flow<Boolean> = store.data.map { it[NOTIFY_PAUSED] ?: false }
    /**
     * The server's CAST_RECEIVER_APP_ID as last seen (`/api/cast/config`; "" = Default Media Receiver). The Cast framework reads its
     * options once per process, so a changed id takes effect after the app restarts.
     */
    val castReceiverAppId: Flow<String> = store.data.map { it[CAST_RECEIVER_APP_ID] ?: "" }
    /** the server offers casting (`/api/cast/config` `enabled`) as last seen */
    val castEnabled: Flow<Boolean> = store.data.map { it[CAST_ENABLED] ?: false }
    /** The app asked for the notification permission once on its own (it never asks again unprompted; the settings screen can). */
    val notifyPermissionAsked: Flow<Boolean> = store.data.map { it[NOTIFY_PERMISSION_ASKED] ?: false }

    suspend fun setServerOrigin(origin: HttpUrl) { store.edit { it[SERVER_ORIGIN] = origin.origin() } }
    suspend fun clearServerOrigin() { store.edit { it.remove(SERVER_ORIGIN); it.remove(AUTH_ORIGIN) } }
    suspend fun setAuthOrigin(origin: HttpUrl?) {
        store.edit { if (origin == null) it.remove(AUTH_ORIGIN) else it[AUTH_ORIGIN] = origin.origin() }
    }
    suspend fun setStorage(value: StorageLocation) { store.edit { it[STORAGE] = value.name } }
    suspend fun setWifiOnly(value: Boolean) { store.edit { it[WIFI_ONLY] = value } }
    suspend fun setBackgroundAudio(value: Boolean) { store.edit { it[BACKGROUND_AUDIO] = value } }
    suspend fun setNotifyCategories(value: Set<String>) { store.edit { it[NOTIFY_CATEGORIES] = value } }
    suspend fun setNotifyLastId(origin: String, id: Long) { store.edit { it[NOTIFY_LAST_ORIGIN] = origin; it[NOTIFY_LAST_ID] = id } }
    suspend fun setNotifyPaused(value: Boolean) { store.edit { it[NOTIFY_PAUSED] = value } }
    suspend fun setNotifyPermissionAsked() { store.edit { it[NOTIFY_PERMISSION_ASKED] = true } }

    /** Signed out of this device: the poller starts over (the next account on this server must not inherit the last seen id). */
    suspend fun forgetSession() { store.edit { it.remove(NOTIFY_LAST_ID); it.remove(NOTIFY_LAST_ORIGIN); it.remove(NOTIFY_PAUSED) } }

    /** Another server: [forgetSession] plus what was learned about the old server (its cast configuration). Choices stay. */
    suspend fun forgetServer() {
        store.edit {
            it.remove(NOTIFY_LAST_ID); it.remove(NOTIFY_LAST_ORIGIN); it.remove(NOTIFY_PAUSED)
            it.remove(CAST_ENABLED); it.remove(CAST_RECEIVER_APP_ID); it.remove(AUTH_ORIGIN)
        }
        castMirror("")
    }

    suspend fun setCastConfig(enabled: Boolean, receiverAppId: String) {
        store.edit { it[CAST_ENABLED] = enabled; it[CAST_RECEIVER_APP_ID] = receiverAppId }
        castMirror(receiverAppId)
    }

    companion object {
        private val SERVER_ORIGIN = stringPreferencesKey("serverOrigin")
        private val AUTH_ORIGIN = stringPreferencesKey("authOrigin")
        private val STORAGE = stringPreferencesKey("storage")
        private val WIFI_ONLY = booleanPreferencesKey("wifiOnly")
        private val BACKGROUND_AUDIO = booleanPreferencesKey("backgroundAudio")
        private val NOTIFY_CATEGORIES = stringSetPreferencesKey("notifyCategories")
        private val NOTIFY_LAST_ID = longPreferencesKey("notifyLastId")
        private val NOTIFY_LAST_ORIGIN = stringPreferencesKey("notifyLastOrigin")
        private val NOTIFY_PAUSED = booleanPreferencesKey("notifyPaused")
        private val CAST_RECEIVER_APP_ID = stringPreferencesKey("castReceiverAppId")
        private val CAST_ENABLED = booleanPreferencesKey("castEnabled")
        private val NOTIFY_PERMISSION_ASKED = booleanPreferencesKey("notifyPermissionAsked")

        private const val CAST_MIRROR = "cast"

        fun from(context: Context): AppSettings {
            val app = context.applicationContext
            return AppSettings(app.dataStore) { id ->
                app.getSharedPreferences(CAST_MIRROR, Context.MODE_PRIVATE).edit { putString(CAST_RECEIVER_APP_ID.name, id) }
            }
        }

        /** the cached receiver app id, synchronously ("" = none / Default Media Receiver) */
        fun castReceiverAppIdNow(context: Context): String =
            context.applicationContext.getSharedPreferences(CAST_MIRROR, Context.MODE_PRIVATE).getString(CAST_RECEIVER_APP_ID.name, "") ?: ""
    }
}
