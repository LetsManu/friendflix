// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.espresso.intent.matcher.IntentMatchers.hasExtra
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.friendflix.android.settings.AppSettings
import app.friendflix.android.shell.ShellActivity
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.hamcrest.Matchers.allOf
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs in the emulator job only. No test depends on the network: the shell is pointed at the placeholder host, and every page the
 * tests look at is local content loaded with that host as its base URL.
 */
@RunWith(AndroidJUnit4::class)
class ShellTest {
    private class Req(private val url: String) : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = true
        override fun isRedirect() = false
        override fun hasGesture() = true
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    @Before fun saveServer() {
        runBlocking { AppSettings.from(ApplicationProvider.getApplicationContext()).setServerOrigin("https://friend.example.com".toHttpUrl()) }
        Intents.init()
    }

    @After fun cleanUp() {
        Intents.release()
        runBlocking { AppSettings.from(ApplicationProvider.getApplicationContext()).clearServerOrigin() }
    }

    private fun ActivityScenario<ShellActivity>.webView(): WebView {
        var found: WebView? = null
        val deadline = System.currentTimeMillis() + 10_000
        while (found == null && System.currentTimeMillis() < deadline) {
            onActivity { found = it.webView }
            if (found == null) Thread.sleep(50)
        }
        return checkNotNull(found) { "the shell never created its WebView" }
    }

    private fun ActivityScenario<ShellActivity>.onMain(block: (WebView) -> Unit) {
        val view = webView()
        InstrumentationRegistry.getInstrumentation().runOnMainSync { block(view) }
    }

    private fun waitFor(what: String, describe: (() -> String)? = null, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            var ok = false
            InstrumentationRegistry.getInstrumentation().runOnMainSync { ok = condition() }
            if (ok) return
            Thread.sleep(50)
        }
        var state = ""
        if (describe != null) InstrumentationRegistry.getInstrumentation().runOnMainSync { state = " (" + describe() + ")" }
        throw AssertionError("timed out waiting for $what$state")
    }

    /**
     * Shows local content under [base]. The shell has already started loading the saved server (which does not exist): that load must be
     * cancelled first, or its error page can land after ours and replace it, and it would sit in the back history.
     */
    private fun WebView.showLocal(html: String, base: String) {
        stopLoading()
        loadDataWithBaseURL(base, html, "text/html", "utf-8", base)
    }


    @Test fun externalLinkOpensChooser() {
        intending(hasAction(Intent.ACTION_CHOOSER)).respondWith(Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null))
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            var handled = false
            scenario.onMain { view -> handled = view.webViewClient.shouldOverrideUrlLoading(view, Req("https://other.evil.test/page")) }
            assertTrue("external navigation must be taken over", handled)
            intended(
                allOf(
                    hasAction(Intent.ACTION_CHOOSER),
                    hasExtra(
                        Intent.EXTRA_INTENT,
                        allOf(hasAction(Intent.ACTION_VIEW), hasData(Uri.parse("https://other.evil.test/page"))),
                    ),
                ),
            )
        }
    }

    @Test fun webViewIsHardened() {
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            scenario.onMain { view ->
                assertTrue(view.settings.safeBrowsingEnabled)
                assertTrue(view.settings.javaScriptEnabled)
                assertFalse(view.settings.allowFileAccess)
                assertFalse(view.settings.allowContentAccess)
                assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, view.settings.mixedContentMode)
                assertTrue(view.settings.userAgentString.endsWith(" FriendFlixAndroid/${BuildConfig.VERSION_NAME}"))
            }
        }
    }

    @Test fun appOriginStaysInsideTheWebView() {
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            var handled = true
            scenario.onMain { view -> handled = view.webViewClient.shouldOverrideUrlLoading(view, Req("https://friend.example.com/watch/1")) }
            assertFalse(handled)
        }
    }

    /**
     * Back at the first page leaves the app, on a real WebView. Walking the history is covered by ShellBackTest (unit): offline on the
     * emulator a loadDataWithBaseURL page gets no history entries (neither from a second load, pushState nor a fragment step).
     */
    @Test fun backAtTheFirstPageFinishes() {
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            scenario.onMain { it.showLocal("<html><head><title>one</title></head><body>one</body></html>", "https://friend.example.com/") }
            val view = scenario.webView()
            waitFor("first page") { view.title == "one" }
            var canGoBack = true
            scenario.onMain { canGoBack = it.canGoBack() }
            assertFalse("a fresh shell has no history to go back to", canGoBack)
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            waitForState(scenario, Lifecycle.State.DESTROYED)
        }
    }

    private fun waitForState(scenario: ActivityScenario<ShellActivity>, state: Lifecycle.State) {
        val deadline = System.currentTimeMillis() + 10_000
        while (scenario.state != state && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertEquals(state, scenario.state)
    }

    @Test fun bridgeAnswersTheAppPageAndIsInvisibleToForeignOrigins() {
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            val html = "<html><head><title>b</title></head><body><script>" +
                "window.__r = null; window.FriendFlixNative.onmessage = function (e) { window.__r = e.data; };" +
                "window.FriendFlixNative.postMessage(JSON.stringify({id: 'x1', method: 'capabilities', args: {}}));" +
                "</script></body></html>"
            scenario.onMain { it.showLocal(html, "https://friend.example.com/b") }
            val view = scenario.webView()
            var reply: String? = null
            waitFor("the bridge reply") {
                view.evaluateJavascript("window.__r") { reply = it }
                reply != null && reply != "null"
            }
            assertTrue(reply.orEmpty().contains("\\\"ok\\\":true"))
            // this build plays, downloads and casts natively (Tasks 6 / 8 / 9)
            assertTrue(reply.orEmpty().contains("\\\"play\\\":true"))
            assertTrue(reply.orEmpty().contains("\\\"download\\\":true"))
            assertTrue(reply.orEmpty().contains("\\\"cast\\\":true"))

            // The shell would (rightly) cancel a foreign top-level page, which is not what is under test here: show it through a plain client.
            scenario.onMain {
                it.webViewClient = WebViewClient()
                it.showLocal("<html><body>x</body></html>", "https://other.evil.test/")
            }
            var defined: String? = null
            waitFor("the foreign page") {
                view.evaluateJavascript("typeof window.FriendFlixNative + ':' + location.origin") { defined = it }
                defined?.contains("evil.test") == true
            }
            assertEquals("\"undefined:https://other.evil.test\"", defined)
        }
    }
}
