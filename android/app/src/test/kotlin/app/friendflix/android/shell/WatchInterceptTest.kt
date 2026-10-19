// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** A same-origin `/watch/<id>` page load (deep link, reload, link) opens the native player; a declined one loads the web player. */
@RunWith(RobolectricTestRunner::class)
class WatchInterceptTest {
    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val policy = OriginPolicy("https://friend.example.com".toHttpUrl())
    private val asked = mutableListOf<WatchLink>()
    private var answer = true
    private val client = ShellWebViewClient(policy, openExternal = { error("must not open externally") }, onWatch = { asked += it; answer })
    private val view = WebView(context).also { it.webViewClient = client }

    private class Req(private val url: String, private val main: Boolean = true) : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = main
        override fun isRedirect() = false
        override fun hasGesture() = true
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    @Test fun parsesTheWatchRoute() {
        val l = WatchLinks.parse(Uri.parse("https://friend.example.com/watch/5f1e2d3c?t=95&audio=jpn&sub=ger"), policy)!!
        assertEquals(WatchLink("5f1e2d3c", startMs = 95_000, audio = "jpn", subtitle = "ger"), l)
        assertEquals(WatchLink("abc", null, null, null), WatchLinks.parse(Uri.parse("https://friend.example.com/watch/abc/"), policy))
        assertNull("other origin", WatchLinks.parse(Uri.parse("https://evil.example.com/watch/abc"), policy))
        assertNull("other port", WatchLinks.parse(Uri.parse("https://friend.example.com:8443/watch/abc"), policy))
        assertNull("not the watch page", WatchLinks.parse(Uri.parse("https://friend.example.com/watchlist"), policy))
        assertNull("nested path", WatchLinks.parse(Uri.parse("https://friend.example.com/watch/abc/x"), policy))
        assertNull("bad id", WatchLinks.parse(Uri.parse("https://friend.example.com/watch/a%2Fb"), policy))
        // out-of-range / malformed query values are dropped, not passed on
        assertEquals(WatchLink("abc", null, null, null), WatchLinks.parse(Uri.parse("https://friend.example.com/watch/abc?t=-1&audio=%3Cx%3E"), policy))
        assertEquals(WatchLink("abc", null, null, null), WatchLinks.parse(Uri.parse("https://friend.example.com/watch/abc?t=90000"), policy))
    }

    @Test fun linkToTheWatchPageOpensTheNativePlayerAndKeepsThePage() {
        assertTrue("navigation cancelled: the WebView stays on the previous page", client.shouldOverrideUrlLoading(view, Req("https://friend.example.com/watch/abc?t=10")))
        assertEquals(listOf(WatchLink("abc", 10_000, null, null)), asked)
    }

    @Test fun declinedLinkLoadsTheWebPlayer() {
        answer = false
        assertFalse(client.shouldOverrideUrlLoading(view, Req("https://friend.example.com/watch/abc")))
        // the page load that follows is not asked about again
        client.onPageStarted(view, "https://friend.example.com/watch/abc", null)
        assertEquals(1, asked.size)
    }

    @Test fun otherPagesAndFramesAreNotIntercepted() {
        assertFalse(client.shouldOverrideUrlLoading(view, Req("https://friend.example.com/item/abc")))
        assertFalse(client.shouldOverrideUrlLoading(view, Req("https://friend.example.com/watch/abc", main = false)))
        client.onPageStarted(view, "https://friend.example.com/", null)
        assertTrue(asked.isEmpty())
    }

    @Test fun reloadOrDeepLinkOfTheWatchPageOpensTheNativePlayer() {
        // loadUrl / reload do not go through shouldOverrideUrlLoading: the page start is the hook
        client.onPageStarted(view, "https://friend.example.com/watch/abc", null)
        assertEquals(listOf(WatchLink("abc", null, null, null)), asked)
        // nothing to go back to: the WebView shows the app's start page instead of the watch page
        assertEquals("https://friend.example.com/", shadowOf(view).lastLoadedUrl)
    }

    @Test fun declinedReloadLetsTheWebPlayerLoad() {
        answer = false
        client.onPageStarted(view, "https://friend.example.com/watch/abc", null)
        assertEquals(1, asked.size)
        assertNull("nothing replaced the load", shadowOf(view).lastLoadedUrl)
    }

    @Test fun withoutAPlayerNothingIsIntercepted() {
        val plain = ShellWebViewClient(policy, openExternal = { error("must not open") })
        assertFalse(plain.shouldOverrideUrlLoading(view, Req("https://friend.example.com/watch/abc")))
    }
}
