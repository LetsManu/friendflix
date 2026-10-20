// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.os.Build
import android.view.View
import android.widget.ImageView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import kotlin.coroutines.CoroutineContext

/**
 * The seek bar's preview while scrubbing (web Player.svelte `thumb`): the trickplay frame of the scrub position ([trickplayFrame],
 * [sheetUrl]). A sheet is fetched once ([ImageLoader.bytes], same origin only) and kept in a small cache of its own ([MAX_SHEETS]
 * sheets, never the posters' cache): compressed, with only the shown tile decoded ([BitmapRegionDecoder]), so a sheet of any size
 * costs one tile of memory; where the platform has no region decoder for it, decoded once in RGB 565 and scaled down to at most
 * [SHEET_BUDGET_BYTES]. At most one fetch and one decode run at a time: a scrub that moves on only changes the wanted frame, which
 * is drawn when the running step ends. The view's width (168 dp) is set by the layout.
 */
class TrickplayPreview(
    private val view: ImageView,
    private val images: ImageLoader,
    private val scope: CoroutineScope,
    private val decodeContext: CoroutineContext = Dispatchers.Default,
) {
    /** a sheet ready to cut tiles from (rectangles in the sheet's own pixels) */
    private interface Sheet {
        fun tile(x: Int, y: Int, w: Int, h: Int): Bitmap?
    }

    /** sheets by URL, least recently used first */
    private val sheets = object : LinkedHashMap<String, Sheet>(MAX_SHEETS + 1, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Sheet>?) = size > MAX_SHEETS
    }
    /** sheets that could not be had: not asked again by this preview */
    private val failed = HashSet<String>()
    /** the frame wanted (null while hidden) and the one on show */
    private var wanted: Pair<String, Frame>? = null
    private var drawn: Pair<String, Frame>? = null
    private var fetching: String? = null
    private var decoding = false

    /** sheet fetches started (tests) */
    var fetches = 0
        private set

    fun show(info: TrickplayInfo, positionMs: Long) {
        if (!usable(info)) { hide(); return }
        val frame = trickplayFrame(info, positionMs)
        wanted = sheetUrl(info, frame.sheet) to frame
        view.visibility = View.VISIBLE
        step()
    }

    fun hide() {
        wanted = null
        drawn = null
        view.visibility = View.GONE
    }

    /** the next thing to do for [wanted]: nothing, fetch its sheet, or decode its tile */
    private fun step() {
        val w = wanted ?: return
        if (w == drawn || decoding || w.first in failed) return
        val sheet = sheets[w.first]
        if (sheet == null) { fetch(w.first); return }
        decoding = true
        scope.launch {
            val f = w.second
            val tile = try { withContext(decodeContext) { sheet.tile(f.x, f.y, f.width, f.height) } } finally { decoding = false }
            if (wanted == null) return@launch // hidden meanwhile
            drawn = w
            if (tile != null) view.setImageBitmap(tile)
            step() // the scrub may have moved on
        }
    }

    private fun fetch(url: String) {
        if (fetching != null) return // one at a time; when it ends the wanted sheet is looked at again
        fetching = url
        fetches++
        scope.launch {
            val decoder = try { withContext(Dispatchers.IO) { images.bytes(url, MAX_SHEET_BYTES)?.let(::sheet) } } finally { fetching = null }
            if (decoder != null) sheets[url] = decoder else failed += url
            step()
        }
    }

    private fun sheet(bytes: ByteArray): Sheet? = region(bytes) ?: sampled(bytes)

    /** compressed; each tile decoded on its own */
    private fun region(bytes: ByteArray): Sheet? {
        val d = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) BitmapRegionDecoder.newInstance(bytes, 0, bytes.size)
            else @Suppress("DEPRECATION") BitmapRegionDecoder.newInstance(bytes, 0, bytes.size, false)
        } catch (_: IOException) {
            null
        } catch (_: OutOfMemoryError) {
            null
        } ?: return null
        return object : Sheet {
            override fun tile(x: Int, y: Int, w: Int, h: Int): Bitmap? {
                val r = Rect(x, y, minOf(x + w, d.width), minOf(y + h, d.height))
                if (x < 0 || y < 0 || r.isEmpty) return null
                return guard { synchronized(d) { d.decodeRegion(r, null) } }
            }
        }
    }

    /** decoded once, RGB 565, halved until it fits [SHEET_BUDGET_BYTES]; the tile's rectangle is scaled with it */
    private fun sampled(bytes: ByteArray): Sheet? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while ((bounds.outWidth.toLong() / sample) * (bounds.outHeight.toLong() / sample) * 2 > SHEET_BUDGET_BYTES) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.RGB_565 }
        val bmp = guard { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) } ?: return null
        val k = bmp.width.toFloat() / bounds.outWidth
        return object : Sheet {
            override fun tile(x: Int, y: Int, w: Int, h: Int): Bitmap? {
                val sx = (x * k).toInt()
                val sy = (y * k).toInt()
                val sw = minOf((w * k).toInt(), bmp.width - sx)
                val sh = minOf((h * k).toInt(), bmp.height - sy)
                if (sx < 0 || sy < 0 || sw <= 0 || sh <= 0) return null
                return guard { Bitmap.createBitmap(bmp, sx, sy, sw, sh) }
            }
        }
    }

    /** a decode that fails (bad data, no memory) shows nothing */
    private inline fun guard(block: () -> Bitmap?): Bitmap? = try {
        block()
    } catch (_: IllegalArgumentException) {
        null
    } catch (_: IllegalStateException) {
        null
    } catch (_: OutOfMemoryError) {
        null
    }

    companion object {
        /** the preview's width (web previewW) */
        const val WIDTH_DP = 168
        /** compressed sheets kept (the one scrubbed in and its neighbour) */
        const val MAX_SHEETS = 2
        /** a sheet's compressed size at most (a 10×10 sheet of 640 px JPEG tiles is well below) */
        const val MAX_SHEET_BYTES = 8 * 1024 * 1024
        /** pixels of a sheet decoded whole (no region decoder): a default 10×10 sheet of 320×180 tiles fits unscaled */
        const val SHEET_BUDGET_BYTES = 12L * 1024 * 1024

        /** [trickplayFrame] clamps but can give a zero-size frame: no preview for such an info */
        fun usable(i: TrickplayInfo): Boolean = i.width > 0 && i.height > 0 && i.count > 0 && i.intervalMs > 0 && i.tileWidth > 0 && i.tileHeight > 0
    }
}
