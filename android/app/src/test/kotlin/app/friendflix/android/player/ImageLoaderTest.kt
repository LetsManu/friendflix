// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.graphics.Bitmap
import android.graphics.Color
import android.widget.ImageView
import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.downloads.FakeCookies
import app.friendflix.android.downloads.ServerApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
class ImageLoaderTest {
    private val server = MockWebServer()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private val routes = HashMap<String, Pair<Int, ByteArray>>()
    private lateinit var api: ServerApi

    private fun png(w: Int, h: Int): ByteArray {
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        val out = java.io.ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    @Before fun setUp() {
        routes["/media/a"] = 200 to png(200, 100)
        routes["/media/big"] = 200 to ByteArray(5000)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val (code, body) = routes[request.url.encodedPath] ?: (404 to ByteArray(0))
                return MockResponse.Builder().code(code).body(Buffer().write(body)).build()
            }
        }
        server.start()
        api = ServerApi(server.url("/"), OkHttpClient(), FakeCookies())
    }

    @After fun tearDown() { server.close() }

    @Test fun loadsAndCaches() = runBlocking {
        val l = ImageLoader(api)
        val first = l.load("/media/a", 200)
        assertNotNull(first)
        assertEquals(200, first!!.width)
        assertNotNull(l.load("/media/a", 200))
        assertEquals(1, seen.size)
    }

    @Test fun downsamplesToTheTargetWidth() = runBlocking {
        val bmp = ImageLoader(api).load("/media/a", 50)!!
        assertTrue(bmp.width in 50..100)
    }

    @Test fun foreignOrAbsoluteOrRelativeIsNullWithoutRequest() = runBlocking {
        val l = ImageLoader(api)
        assertNull(l.load("http://evil.example/x.png", 100))
        assertNull(l.load("//evil.example/x.png", 100))
        assertNull(l.load("media/a", 100))
        assertEquals(0, seen.size)
    }

    @Test fun notFoundIsNull() = runBlocking {
        assertNull(ImageLoader(api).load("/media/missing", 100))
    }

    @Test fun oversizeIsNull() = runBlocking {
        assertNull(ImageLoader(api, maxBytes = 1000).load("/media/big", 100))
    }

    @Test fun sessionExpiredIsNull() = runBlocking {
        routes["/media/a"] = 401 to ByteArray(0)
        assertNull(ImageLoader(api).load("/media/a", 100))
    }

    private val scope = CoroutineScope(Dispatchers.Unconfined)

    @Test fun intoSetsBitmapAndNullClears() = runBlocking {
        val view = ImageView(ApplicationProvider.getApplicationContext())
        val l = ImageLoader(api)
        l.into(view, "/media/a", 200, scope)!!.join()
        assertNotNull((view.drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap)
        l.into(view, null, 200, scope)
        assertNull(view.drawable)
    }

    @Test fun staleLoadDoesNotOverwriteANewerTag() = runBlocking {
        val view = ImageView(ApplicationProvider.getApplicationContext())
        val l = ImageLoader(api)
        val first = l.into(view, "/media/a", 200, scope)!!
        l.into(view, null, 200, scope) // recycled before the first load finished
        first.join()
        assertNull(view.drawable)
    }
}
