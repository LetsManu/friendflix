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

    private fun waitFor(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            var ok = false
            InstrumentationRegistry.getInstrumentation().runOnMainSync { ok = condition() }
            if (ok) return
            Thread.sleep(50)
        }
        throw AssertionError("timed out waiting for $what")
    }

    private fun page(title: String) = "<html><head><title>$title</title></head><body>$title</body></html>"

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

    @Test fun backNavigatesHistoryThenFinishes() {
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            scenario.onMain { it.loadDataWithBaseURL("https://friend.example.com/one", page("one"), "text/html", "utf-8", "https://friend.example.com/one") }
            val view = scenario.webView()
            waitFor("first page") { view.title == "one" }
            scenario.onMain { it.loadDataWithBaseURL("https://friend.example.com/two", page("two"), "text/html", "utf-8", "https://friend.example.com/two") }
            waitFor("second page") { view.title == "two" && view.canGoBack() }

            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            waitFor("back to the first page") { view.title == "one" }
            assertEquals(Lifecycle.State.RESUMED, scenario.state)

            // the history may still hold the entry before "one": walk back to the start, then one more back finishes the activity
            var guard = 0
            while (guard++ < 5) {
                var canGoBack = false
                scenario.onMain { canGoBack = it.canGoBack() }
                if (!canGoBack) break
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                Thread.sleep(200)
            }
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            waitForState(scenario, Lifecycle.State.DESTROYED)
        }
    }

    private fun waitForState(scenario: ActivityScenario<ShellActivity>, state: Lifecycle.State) {
        val deadline = System.currentTimeMillis() + 10_000
        while (scenario.state != state && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertEquals(state, scenario.state)
    }
}
