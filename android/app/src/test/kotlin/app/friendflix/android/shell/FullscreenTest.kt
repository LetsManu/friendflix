// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.widget.FrameLayout
import androidx.test.core.app.ApplicationProvider
import androidx.webkit.WebSettingsCompat
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FullscreenTest {
    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val container = FrameLayout(context).apply { visibility = View.GONE }

    private class Cb : WebChromeClient.CustomViewCallback {
        var hidden = 0
        override fun onCustomViewHidden() { hidden++ }
    }

    @Test fun theVideoGoesOverTheWholeScreenAndBackLeavesIt() {
        val f = FullscreenVideo(container, null)
        val video = View(context)
        val cb = Cb()
        f.show(video, cb)
        assertTrue(f.isShowing)
        assertEquals(View.VISIBLE, container.visibility)
        assertEquals(video, container.getChildAt(0))
        f.exit() // Android back
        assertFalse(f.isShowing)
        assertEquals(View.GONE, container.visibility)
        assertEquals(0, container.childCount)
        assertEquals(1, cb.hidden) // the page is told
        f.hide() // the WebView's onHideCustomView afterwards: nothing left to do
        assertEquals(1, cb.hidden)
    }

    @Test fun aSecondRequestWhileShowingIsRefused() {
        val f = FullscreenVideo(container, null)
        f.show(View(context), Cb())
        val second = Cb()
        f.show(View(context), second)
        assertEquals(1, second.hidden)
        assertEquals(1, container.childCount)
    }

    @Test fun theChromeClientUsesTheHostOrRefuses() {
        val f = FullscreenVideo(container, null)
        val client = ShellChromeClient(f)
        client.onShowCustomView(View(context), Cb())
        assertTrue(f.isShowing)
        client.onHideCustomView() // the page left fullscreen itself
        assertFalse(f.isShowing)
        val none = Cb()
        ShellChromeClient(null).onShowCustomView(View(context), none)
        assertEquals(1, none.hidden)
    }

    @Test fun theShellWebViewHasTheChromeClient() {
        val view = WebViewFactory.create(context, OriginPolicy("https://friend.example.com".toHttpUrl()), "2.0.0", fullscreen = FullscreenVideo(container, null)) {}
        assertTrue(view.webChromeClient is ShellChromeClient)
    }

    @Test fun passkeysUseTheAppModeWhereSupported() {
        val settings = WebViewFactory.create(context, OriginPolicy("https://friend.example.com".toHttpUrl()), "2.0.0") {}.settings
        var mode: Int? = null
        val record = { _: WebSettings, m: Int -> mode = m }
        assertTrue(Passkeys.enable(settings, supported = true, set = record))
        assertEquals(WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP, mode)
        mode = null
        assertFalse(Passkeys.enable(settings, supported = false, set = record))
        assertNull(mode)
    }
}
