// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import android.app.Application
import android.webkit.WebSettings
import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.shell.OriginPolicy
import app.friendflix.android.shell.ShellWebViewClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TvWebViewTest {
    private val ctx = ApplicationProvider.getApplicationContext<Application>()

    @Test fun userAgentMarkerAndDisplay() {
        assertEquals("UA FriendFlixFireTV/3.0.0 FFDisplay/2160", TvWebView.userAgent("UA", "3.0.0", 2160))
        assertEquals(2160, TvWebView.displayHeight(listOf(720, 1080, 2160)))
        assertEquals(1080, TvWebView.displayHeight(emptyList()))
        assertEquals(1080, TvWebView.displayHeight(listOf(0, -1)))
    }

    @Test fun lockedDownTvWebView() {
        val v = TvWebView.create(ctx, OriginPolicy("https://friend.example.com".toHttpUrl()), "3.0.0", 1080, null, {}, {})
        with(v.settings) {
            assertTrue(javaScriptEnabled); assertTrue(domStorageEnabled); assertFalse(allowFileAccess); assertFalse(allowContentAccess)
            assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, mixedContentMode); assertFalse(mediaPlaybackRequiresUserGesture)
            assertTrue(useWideViewPort); assertTrue(loadWithOverviewMode)
            assertTrue(userAgentString.endsWith(" FriendFlixFireTV/3.0.0 FFDisplay/1080")); assertFalse(userAgentString.contains("FriendFlixAndroid/"))
        }
        assertTrue(v.webViewClient is ShellWebViewClient)
    }
}
