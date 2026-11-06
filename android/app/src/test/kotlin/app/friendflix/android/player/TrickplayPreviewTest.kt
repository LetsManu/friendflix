// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.GraphicsMode
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE) // real pixels: the crop is checked by colour
class TrickplayPreviewTest {
    private val server = MockWebServer()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private val sheets = HashMap<String, ByteArray>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var view: ImageView
    private lateinit var preview: TrickplayPreview

    /** 2×2 tiles of 10×5 px per sheet, a frame per second, 10 frames: sheets 0, 1, 2 */
    private val info = TrickplayInfo(width = 10, height = 5, tileWidth = 2, tileHeight = 2, count = 10, intervalMs = 1000, url = "/tp/{n}.png")

    /** tile colours: sheet n, tile t (neighbouring tiles differ by at least 20 in a channel) */
    private fun colour(n: Int, t: Int) = Color.rgb((t * 20) % 256, n * 80, (t / 13) * 40)

    /** the colour on show at the tile's centre, compared per channel within RGB 565's rounding */
    private fun showsColour(c: Int): Boolean {
        val p = shownColour() ?: return false
        return listOf(Color::red, Color::green, Color::blue).all { ch -> kotlin.math.abs(ch(p) - ch(c)) <= 8 }
    }

    private fun sheet(n: Int, tw: Int = 2, th: Int = 2, w: Int = 10, h: Int = 5): ByteArray {
        val b = Bitmap.createBitmap(tw * w, th * h, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        for (t in 0 until tw * th) {
            val x = (t % tw) * w
            val y = (t / tw) * h
            c.drawRect(x.toFloat(), y.toFloat(), (x + w).toFloat(), (y + h).toFloat(), Paint().apply { color = colour(n, t) })
        }
        val out = java.io.ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    @Before fun setUp() {
        for (n in 0..2) sheets["/tp/$n.png"] = sheet(n)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                Thread.sleep(50) // a sheet takes a moment: the scrub moves on meanwhile
                val body = sheets[request.url.encodedPath] ?: return MockResponse.Builder().code(404).build()
                return MockResponse.Builder().code(200).body(Buffer().write(body)).build()
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
        assertTrue("timed out: shown=${shown()?.let { "${it.width}x${it.height}" }} colour=${shownColour()?.let(Integer::toHexString)} paths=${paths()} fetches=${preview.fetches}", done())
    }

    private fun shown(): Bitmap? = (view.drawable as? BitmapDrawable)?.bitmap
    private fun shownColour(): Int? = shown()?.let { it.getPixel(it.width / 2, it.height / 2) }
    private fun paths() = seen.map { it.url.encodedPath }

    @Test fun previewCropsTheTileOfTheScrubPosition() {
        preview.show(info, 5_500) // frame 5: sheet 1, tile 1 (x 10, y 0)
        assertEquals(View.VISIBLE, view.visibility)
        await { showsColour(colour(1, 1)) }
        assertEquals(listOf(sheetUrl(info, 1)), paths())
        assertEquals(10, shown()!!.width)
        assertEquals(5, shown()!!.height)
        preview.show(info, 6_200) // frame 6: tile 2 (x 0, y 5) of the same sheet
        await { showsColour(colour(1, 2)) }
        assertEquals(1, seen.size)
        preview.hide()
        assertEquals(View.GONE, view.visibility)
    }

    @Test fun rapidFrameChangesWithinOneSheetFetchItOnce() {
        for (ms in listOf(4_000L, 4_500, 5_000, 6_000, 7_900)) preview.show(info, ms) // all before the sheet arrives
        await { showsColour(colour(1, 3)) } // the last one wanted: frame 7 = tile 3
        assertEquals(listOf(sheetUrl(info, 1)), paths())
        assertEquals(1, preview.fetches)
    }

    @Test fun aScrubAcrossSheetsFetchesOneAtATimeAndSkipsTheLeftOnes() {
        preview.show(info, 0) // sheet 0
        preview.show(info, 4_000) // sheet 1: never needed by the time sheet 0 is in
        preview.show(info, 9_000) // sheet 2, frame 9 = tile 1
        await { showsColour(colour(2, 1)) }
        assertEquals(listOf(sheetUrl(info, 0), sheetUrl(info, 2)), paths())
    }

    @Test fun aSheetLargerThanThePosterCacheStillPreviews() {
        // 10×10 tiles of 400×200 px: 4000×2000, 32 MB as pixels (the posters' cache holds 24 MB)
        sheets["/big/0.png"] = sheet(0, tw = 10, th = 10, w = 400, h = 200)
        val big = TrickplayInfo(width = 400, height = 200, tileWidth = 10, tileHeight = 10, count = 100, intervalMs = 10_000, url = "/big/{n}.png")
        preview.show(big, 125_000) // frame 12: tile 12 (x 800, y 200)
        await { showsColour(colour(0, 12)) }
        // whole (region decode) or scaled to the sheet budget: the tile's shape either way
        assertTrue(shown()!!.width >= 200)
        assertEquals(shown()!!.width, shown()!!.height * 2)
    }

    @Test fun aFailedSheetIsNotAskedAgain() {
        val missing = info.copy(url = "/none/{n}.png")
        preview.show(missing, 1_000)
        await { seen.size == 1 && preview.fetches == 1 }
        Thread.sleep(100)
        preview.show(missing, 2_000)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, seen.size)
        assertNull(shown())
    }

    @Test fun aFailedSheetIsAskedAgainOnTheNextScrub() {
        sheets.remove("/tp/1.png") // a sheet the server could not give for a moment
        preview.show(info, 5_500)
        await { seen.size == 1 && preview.fetches == 1 }
        Thread.sleep(100)
        shadowOf(Looper.getMainLooper()).idle()
        preview.hide() // the scrub ends
        sheets["/tp/1.png"] = sheet(1)
        preview.show(info, 5_500) // a new scrub tries it again
        await { showsColour(colour(1, 1)) }
        assertEquals(2, preview.fetches)
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
