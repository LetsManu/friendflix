// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PageFrameTest {
    private fun insets(status: Int, nav: Int, ime: Int = 0) = WindowInsetsCompat.Builder()
        .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, status, 0, 0))
        .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, nav))
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, ime))
        .build()

    @Test fun theFramePadsTheBarsAndTheWebViewStaysUnpadded() {
        val web = View(ApplicationProvider.getApplicationContext())
        val frame = pageFrame(ApplicationProvider.getApplicationContext(), web)
        val rest = ViewCompat.dispatchApplyWindowInsets(frame, insets(status = 63, nav = 48))
        assertEquals(listOf(0, 63, 0, 48), listOf(frame.paddingLeft, frame.paddingTop, frame.paddingRight, frame.paddingBottom))
        assertEquals(listOf(0, 0, 0, 0), listOf(web.paddingLeft, web.paddingTop, web.paddingRight, web.paddingBottom))
        assertTrue("insets are consumed, the page adds no second gap", rest.isConsumed)
    }

    @Test fun theKeyboardLiftsTheBottom() {
        val frame = pageFrame(ApplicationProvider.getApplicationContext(), View(ApplicationProvider.getApplicationContext()))
        ViewCompat.dispatchApplyWindowInsets(frame, insets(status = 63, nav = 48, ime = 800))
        assertEquals(800, frame.paddingBottom)
    }
}
