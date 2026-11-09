// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import android.app.Application
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import androidx.test.core.app.ApplicationProvider
import androidx.webkit.WebViewFeature
import app.friendflix.android.shell.OriginPolicy
import app.friendflix.android.shell.ShellWebViewClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

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

    private val policy = OriginPolicy("https://friend.example.com".toHttpUrl())

    private class Req(private val url: String, private val main: Boolean = true) : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = main
        override fun isRedirect() = false
        override fun hasGesture() = false
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    @Test fun wiresSignInOriginDownloadsAndThePort() {
        val auth = OriginPolicy("https://login.example.com".toHttpUrl())
        val v = TvWebView.create(ctx, policy, "3.0.0", 1080, auth, {}, {})
        assertSame(auth, (v.webViewClient as ShellWebViewClient).authOrigin)
        assertNotNull(shadowOf(v).downloadListener) // set: every download is dropped
        // the message port: the listener where the WebView has it, else the JavaScript interface of the same name
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            assertNotNull(shadowOf(v).getJavascriptInterface(TvMessages.PORT))
        }
    }

    @Test fun linksToOtherSitesAreDropped() {
        val v = TvWebView.create(ctx, policy, "3.0.0", 1080, null, {}, {})
        assertTrue(v.webViewClient.shouldOverrideUrlLoading(v, Req("https://other.example.net/x")))
        assertFalse(v.webViewClient.shouldOverrideUrlLoading(v, Req("https://friend.example.com/tv")))
    }

    @Test fun loadedOnlyForAnAppPageWithoutError() {
        val loaded = mutableListOf<String>()
        val v = TvWebView.create(ctx, policy, "3.0.0", 1080, null, {}, {}) { loaded += it }
        val c = v.webViewClient
        val start = "https://friend.example.com/tv?ff_app=firetv&probe=1"

        c.onPageStarted(v, start, null)
        c.onReceivedHttpError(v, Req(start), WebResourceResponse("text/html", "utf-8", 502, "Bad Gateway", emptyMap(), null))
        c.onPageFinished(v, start)
        assertEquals(emptyList<String>(), loaded) // the server answered with an error

        c.onPageStarted(v, start, null)
        c.onReceivedHttpError(v, Req("https://friend.example.com/x.png", main = false), WebResourceResponse("image/png", null, 404, "Not Found", emptyMap(), null))
        c.onPageFinished(v, start)
        assertEquals(listOf(start), loaded) // a missing image does not count against the page

        c.onPageFinished(v, "about:blank")
        assertEquals(1, loaded.size)
    }
}
