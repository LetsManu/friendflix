// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class WebViewFactoryTest {
    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val policy = OriginPolicy("https://friend.example.com".toHttpUrl())

    private class Req(private val url: String, private val main: Boolean = true) : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = main
        override fun isRedirect() = false
        override fun hasGesture() = true
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    @Test fun hardenedSettings() {
        val view = WebViewFactory.create(context, policy, "2.0.0") {}
        val s = view.settings
        assertTrue(s.javaScriptEnabled)
        assertTrue(s.domStorageEnabled)
        assertFalse(s.allowFileAccess)
        assertFalse(s.allowContentAccess)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, s.mixedContentMode)
        // safeBrowsingEnabled is not modelled by Robolectric; ShellTest checks it on a real WebView
        assertTrue(s.userAgentString.endsWith(" FriendFlixAndroid/2.0.0"))
    }

    @Test fun appOriginStaysInWebView() {
        val view = WebViewFactory.create(context, policy, "2.0.0") { error("must not open externally") }
        assertFalse(view.webViewClient.shouldOverrideUrlLoading(view, Req("https://friend.example.com/watch/1")))
    }

    @Test fun externalLinkIsHandedOut() {
        var opened: Uri? = null
        val view = WebViewFactory.create(context, policy, "2.0.0") { opened = it }
        assertTrue(view.webViewClient.shouldOverrideUrlLoading(view, Req("https://other.evil.test/x")))
        assertEquals("https://other.evil.test/x", opened.toString())
    }

    @Test fun nonWebSchemesAreBlockedNotOpened() {
        val view = WebViewFactory.create(context, policy, "2.0.0") { error("must not open") }
        for (u in listOf("intent://x#Intent;end", "javascript:alert(1)", "file:///etc/hosts", "content://x/y")) {
            assertTrue(u, view.webViewClient.shouldOverrideUrlLoading(view, Req(u)))
        }
    }

    @Test fun mailAndTelAreOpened() {
        var opened: Uri? = null
        val view = WebViewFactory.create(context, policy, "2.0.0") { opened = it }
        assertTrue(view.webViewClient.shouldOverrideUrlLoading(view, Req("mailto:a@friend.example.com")))
        assertNotNull(opened)
    }

    @Test fun subframeNavigationIsNotHandedOut() {
        val view = WebViewFactory.create(context, policy, "2.0.0") { error("must not open") }
        assertFalse(view.webViewClient.shouldOverrideUrlLoading(view, Req("https://other.evil.test/", main = false)))
    }

    private val auth = OriginPolicy("https://auth.example.com".toHttpUrl())

    @Test fun authOriginStaysInWebViewInTheMainFrame() {
        val view = WebViewFactory.create(context, policy, "2.0.0", authOrigin = auth) { error("must not open externally") }
        for (u in listOf("https://auth.example.com/application/o/authorize/?client_id=c", "https://AUTH.example.com:443/if/flow/x/")) {
            assertFalse(u, view.webViewClient.shouldOverrideUrlLoading(view, Req(u)))
        }
    }

    @Test fun authOriginLookalikesAndOtherPortsAreHandedOut() {
        val opened = mutableListOf<String>()
        val view = WebViewFactory.create(context, policy, "2.0.0", authOrigin = auth) { opened += it.toString() }
        val foreign = listOf(
            "https://auth.example.com:8443/x", "http://auth.example.com/x", "https://auth.example.com.evil.test/x",
            "https://sub.auth.example.com/x", "https://authexample.com/x",
        )
        for (u in foreign) assertTrue(u, view.webViewClient.shouldOverrideUrlLoading(view, Req(u)))
        assertEquals(foreign, opened)
    }

    @Test fun withoutAuthOriginTheIdentityProviderIsHandedOut() {
        var opened: Uri? = null
        val view = WebViewFactory.create(context, policy, "2.0.0") { opened = it }
        assertTrue(view.webViewClient.shouldOverrideUrlLoading(view, Req("https://auth.example.com/application/o/authorize/")))
        assertEquals("https://auth.example.com/application/o/authorize/", opened.toString())
    }

    @Test fun chooserIntentWrapsViewIntent() {
        val i = ExternalLinks.chooser(Uri.parse("https://other.evil.test/x"), "Open with")
        assertEquals(Intent.ACTION_CHOOSER, i.action)
        @Suppress("DEPRECATION") val inner = i.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_VIEW, inner.action)
        assertEquals("https://other.evil.test/x", inner.dataString)
        assertTrue(inner.categories.contains(Intent.CATEGORY_BROWSABLE))
        assertNull(inner.component)
    }
}

@RunWith(RobolectricTestRunner::class)
class PageStartedBackstopTest {
    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val policy = OriginPolicy("https://friend.example.com".toHttpUrl())

    private class RecordingWebView(context: android.content.Context) : WebView(context) {
        var stopped = 0
        override fun stopLoading() { stopped++; super.stopLoading() }
    }

    @Test fun foreignOriginIsStoppedAndHandedOut() {
        val opened = mutableListOf<Uri>()
        val view = RecordingWebView(context)
        val client = ShellWebViewClient(policy) { opened += it }
        client.onPageStarted(view, "https://other.evil.test/post", null)
        assertEquals(1, view.stopped)
        assertEquals(listOf("https://other.evil.test/post"), opened.map { it.toString() })
        assertEquals("https://friend.example.com/", org.robolectric.Shadows.shadowOf(view).lastLoadedUrl)
    }

    @Test fun authOriginIsLetThroughOnlyWhenKnown() {
        val view = RecordingWebView(context)
        val client = ShellWebViewClient(policy) { error("must not open") }
        client.authOrigin = OriginPolicy("https://auth.example.com".toHttpUrl())
        client.onPageStarted(view, "https://auth.example.com/application/o/authorize/?x=1", null)
        assertEquals(0, view.stopped)
        val opened = mutableListOf<Uri>()
        val other = ShellWebViewClient(policy) { opened += it }
        other.authOrigin = OriginPolicy("https://auth.example.com".toHttpUrl())
        other.onPageStarted(view, "https://auth.example.com:8443/x", null)
        assertEquals(1, view.stopped)
        other.authOrigin = null
        other.onPageStarted(view, "https://auth.example.com/x", null)
        assertEquals(2, view.stopped)
        assertEquals(2, opened.size)
    }

    @Test fun appOriginAndBlankDoNothing() {
        val view = RecordingWebView(context)
        val client = ShellWebViewClient(policy) { error("must not open") }
        client.onPageStarted(view, "https://friend.example.com/watch/1", null)
        client.onPageStarted(view, "about:blank", null)
        assertEquals(0, view.stopped)
    }

    @Test fun committedUrlIsRecorded() {
        val view = RecordingWebView(context)
        val client = ShellWebViewClient(policy) {}
        assertNull(client.committedUrl)
        client.doUpdateVisitedHistory(view, "https://friend.example.com/x", false)
        assertEquals("https://friend.example.com/x", client.committedUrl)
    }
}
