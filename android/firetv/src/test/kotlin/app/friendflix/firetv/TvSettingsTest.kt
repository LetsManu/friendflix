// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv

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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TvSettingsTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var s: TvSettings

    @Before fun open() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        s = TvSettings(PreferenceDataStoreFactory.create(scope = scope) { tmp.newFile("tv.preferences_pb") })
    }

    @After fun close() { scope.cancel() }

    @Test fun emptyAtFirst() = runBlocking {
        assertNull(s.serverOrigin.first())
        assertNull(s.authOrigin.first())
        assertNull(s.probedOrigin.first())
    }

    @Test fun storesServerAuthAndProbedOrigin() = runBlocking {
        s.setServer("https://friend.example.com".toHttpUrl(), "https://192.0.2.5".toHttpUrl())
        assertEquals("https://friend.example.com/", s.serverOrigin.first().toString())
        assertEquals("https://192.0.2.5/", s.authOrigin.first().toString())
        assertNull(s.probedOrigin.first())
        s.setProbedOrigin("https://friend.example.com")
        assertEquals("https://friend.example.com", s.probedOrigin.first())
        s.setServer("https://192.0.2.9".toHttpUrl(), null)
        assertNull(s.authOrigin.first())
        // a server set through the form (also the same one again) runs the first-run check again
        assertNull(s.probedOrigin.first())
        s.setAuthOrigin("https://192.0.2.6".toHttpUrl())
        assertEquals("https://192.0.2.6/", s.authOrigin.first().toString())
        s.setAuthOrigin(null)
        assertNull(s.authOrigin.first())
    }
}
