// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class ShellBackTest {
    private fun webView() = WebView(ApplicationProvider.getApplicationContext())

    @Test fun backWithHistoryGoesBackInsideTheApp() {
        val view = webView()
        shadowOf(view).pushEntryToHistory("https://friend.example.com/one")
        shadowOf(view).pushEntryToHistory("https://friend.example.com/two")
        var finished = false
        shellBack(view) { finished = true }
        assertFalse("back with history must stay in the app", finished)
        assertEquals(1, shadowOf(view).goBackInvocations)
    }

    @Test fun backAtTheFirstPageLeavesTheApp() {
        val view = webView()
        shadowOf(view).pushEntryToHistory("https://friend.example.com/")
        var finished = false
        shellBack(view) { finished = true }
        assertTrue(finished)
        assertEquals(0, shadowOf(view).goBackInvocations)
    }

    @Test fun backBeforeTheWebViewExistsLeavesTheApp() {
        var finished = false
        shellBack(null) { finished = true }
        assertTrue(finished)
    }
}
