// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
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
