// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AppSettingsTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var settings: AppSettings

    @Before fun open() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        settings = AppSettings(PreferenceDataStoreFactory.create(scope = scope) { tmp.newFile("s.preferences_pb") })
    }

    @After fun close() { scope.cancel() }

    @Test fun defaults() = runBlocking {
        assertNull(settings.serverOrigin.first())
        assertEquals(StorageLocation.PHONE, settings.storage.first())
        assertFalse(settings.wifiOnly.first())
        assertFalse(settings.backgroundAudio.first())
        assertEquals(emptySet<String>(), settings.notifyCategories.first())
    }

    @Test fun roundTrip() = runBlocking {
        settings.setServerOrigin("https://friend.example.com:8443".toHttpUrl())
        settings.setStorage(StorageLocation.SD)
        settings.setWifiOnly(true)
        settings.setBackgroundAudio(true)
        settings.setNotifyCategories(setOf("new", "request"))
        assertEquals("https://friend.example.com:8443/", settings.serverOrigin.first().toString())
        assertEquals(StorageLocation.SD, settings.storage.first())
        assertEquals(true, settings.wifiOnly.first())
        assertEquals(true, settings.backgroundAudio.first())
        assertEquals(setOf("new", "request"), settings.notifyCategories.first())
    }
}
