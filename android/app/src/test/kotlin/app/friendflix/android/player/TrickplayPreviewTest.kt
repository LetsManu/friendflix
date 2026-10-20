// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.os.Looper
import android.view.View
import android.widget.ImageView
import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.downloads.FakeCookies
import app.friendflix.android.downloads.ServerApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
class TrickplayPreviewTest {
    private val server = MockWebServer()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var view: ImageView
    private lateinit var preview: TrickplayPreview

    /** 2×2 tiles of 10×5 px per sheet, a frame per second, 10 frames: sheets 0, 1, 2 */
    private val info = TrickplayInfo(width = 10, height = 5, tileWidth = 2, tileHeight = 2, count = 10, intervalMs = 1000, url = "/tp/{n}.jpg")

    private fun png(w: Int, h: Int): ByteArray {
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
        val out = java.io.ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    @Before fun setUp() {
        val sheet = png(20, 10)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                return if (request.url.encodedPath.startsWith("/tp/")) MockResponse.Builder().code(200).body(Buffer().write(sheet)).build()
                else MockResponse.Builder().code(404).build()
            }
        }
        server.start()
        val images = ImageLoader(ServerApi(server.url("/"), OkHttpClient(), FakeCookies()))
        view = ImageView(ApplicationProvider.getApplicationContext())
        view.visibility = View.GONE
        preview = TrickplayPreview(view, images, scope)
    }

    @After fun tearDown() { scope.cancel(); server.close() }

    private fun await(done: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!done() && System.currentTimeMillis() < end) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("timed out", done())
    }

    private fun shown(): Bitmap? = (view.drawable as? BitmapDrawable)?.bitmap

    @Test fun previewRequestsTheSheetForTheScrubPosition() {
        preview.show(info, 5_500) // frame 5: sheet 1, tile 1 (x 10, y 0)
        assertEquals(View.VISIBLE, view.visibility)
        await { shown() != null }
        assertEquals(listOf("/" + sheetUrl(info, 1).trimStart('/')), seen.map { it.url.encodedPath })
        assertEquals(10, shown()!!.width)
        assertEquals(5, shown()!!.height)
        // the same sheet again: from the cache, no second request
        preview.show(info, 4_100)
        await { shown() != null }
        assertEquals(1, seen.size)
        preview.hide()
        assertEquals(View.GONE, view.visibility)
    }

    @Test fun previewIsSkippedForAnUnusableInfo() {
        for (bad in listOf(info.copy(width = 0), info.copy(height = 0), info.copy(count = 0), info.copy(intervalMs = 0))) {
            preview.show(bad, 1_000)
            assertEquals(View.GONE, view.visibility)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(0, seen.size)
    }
}
