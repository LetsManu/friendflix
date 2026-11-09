// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import androidx.core.net.toUri
import app.friendflix.android.shell.OriginPolicy
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TvMessagesTest {
    @Test fun parsesExactMessagesOnly() {
        assertEquals(TvMessage.Exit, TvMessages.parse("exit")); assertEquals(TvMessage.ChangeServer, TvMessages.parse("changeServer"))
        assertEquals(TvMessage.KeepAwake(true), TvMessages.parse("keepAwake:1")); assertEquals(TvMessage.KeepAwake(false), TvMessages.parse("keepAwake:0"))
        for (bad in listOf(null, "", "EXIT", " exit", "keepAwake:2", "changeServer:https://192.0.2.1", "x".repeat(5000))) assertNull(TvMessages.parse(bad))
    }

    @Test fun acceptsTheAppOriginMainFrameOnly() {
        val p = OriginPolicy("https://friend.example.com".toHttpUrl())
        assertTrue(TvMessages.accept("https://friend.example.com".toUri(), isMainFrame = true, p))
        assertFalse(TvMessages.accept("https://friend.example.com".toUri(), isMainFrame = false, p))
        assertFalse(TvMessages.accept("https://login.friend.example.com".toUri(), isMainFrame = true, p)) // identity provider
        assertFalse(TvMessages.accept("http://friend.example.com".toUri(), isMainFrame = true, p))
        assertFalse(TvMessages.accept("https://friend.example.com:8443".toUri(), isMainFrame = true, p))
    }
}
