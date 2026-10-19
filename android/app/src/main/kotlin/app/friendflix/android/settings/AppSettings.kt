// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
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

class AppSettings(private val store: DataStore<Preferences>) {
    val serverOrigin: Flow<HttpUrl?> = store.data.map { it[SERVER_ORIGIN]?.toHttpUrlOrNull() }
    val storage: Flow<StorageLocation> = store.data.map {
        StorageLocation.entries.firstOrNull { e -> e.name == it[STORAGE] } ?: StorageLocation.PHONE
    }
    val wifiOnly: Flow<Boolean> = store.data.map { it[WIFI_ONLY] ?: false }
    val backgroundAudio: Flow<Boolean> = store.data.map { it[BACKGROUND_AUDIO] ?: false }
    val notifyCategories: Flow<Set<String>> = store.data.map { it[NOTIFY_CATEGORIES] ?: emptySet() }

    suspend fun setServerOrigin(origin: HttpUrl) { store.edit { it[SERVER_ORIGIN] = origin.origin() } }
    suspend fun clearServerOrigin() { store.edit { it.remove(SERVER_ORIGIN) } }
    suspend fun setStorage(value: StorageLocation) { store.edit { it[STORAGE] = value.name } }
    suspend fun setWifiOnly(value: Boolean) { store.edit { it[WIFI_ONLY] = value } }
    suspend fun setBackgroundAudio(value: Boolean) { store.edit { it[BACKGROUND_AUDIO] = value } }
    suspend fun setNotifyCategories(value: Set<String>) { store.edit { it[NOTIFY_CATEGORIES] = value } }

    companion object {
        private val SERVER_ORIGIN = stringPreferencesKey("serverOrigin")
        private val STORAGE = stringPreferencesKey("storage")
        private val WIFI_ONLY = booleanPreferencesKey("wifiOnly")
        private val BACKGROUND_AUDIO = booleanPreferencesKey("backgroundAudio")
        private val NOTIFY_CATEGORIES = stringSetPreferencesKey("notifyCategories")

        fun from(context: Context) = AppSettings(context.applicationContext.dataStore)
    }
}
