// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import android.widget.ImageView
import app.friendflix.android.downloads.ServerApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Loads same-origin server images (posters, chapter thumbnails, trickplay sheets) through the cookie client, with a small
 * memory cache. Only paths starting with `/` that resolve to the app's origin are fetched; anything else is null.
 */
class ImageLoader(private val server: ServerApi, private val maxBytes: Int = 4 * 1024 * 1024) {
    private val cache = object : LruCache<String, Bitmap>(CACHE_BYTES) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }

    /** The image at [path] scaled down (power-of-two sample) to at least [targetWidthPx] wide, or null when it cannot be had. */
    suspend fun load(path: String, targetWidthPx: Int): Bitmap? {
        val url = server.resolve(path) ?: return null
        val key = "$path@$targetWidthPx"
        cache.get(key)?.let { return it }
        val bmp = withContext(Dispatchers.IO) {
            try {
                val bytes = server.small(url, maxBytes) ?: return@withContext null
                decode(bytes, targetWidthPx)
            } catch (_: IOException) {
                null // includes SessionExpired: the player's own requests handle sign-out
            } catch (_: RuntimeException) {
                null
            }
        } ?: return null
        cache.put(key, bmp)
        return bmp
    }

    /**
     * Shows [path] in [view]; null clears it. The path is the view's tag while loading, so a recycled view never gets
     * a bitmap meant for its previous content. Returns the load job (null when nothing is loaded).
     */
    fun into(view: ImageView, path: String?, targetWidthPx: Int, scope: CoroutineScope): Job? {
        view.tag = path
        view.setImageDrawable(null)
        if (path == null) return null
        return scope.launch {
            val bmp = load(path, targetWidthPx) ?: return@launch
            if (view.tag == path) view.setImageBitmap(bmp)
        }
    }

    private fun decode(bytes: ByteArray, targetWidthPx: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (targetWidthPx > 0 && bounds.outWidth / (sample * 2) >= targetWidthPx) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private companion object {
        const val CACHE_BYTES = 24 * 1024 * 1024
    }
}
