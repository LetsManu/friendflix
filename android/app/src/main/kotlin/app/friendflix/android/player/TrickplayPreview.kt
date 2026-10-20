// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.graphics.Bitmap
import android.view.View
import android.widget.ImageView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The seek bar's preview while scrubbing (web Player.svelte `thumb`): the trickplay frame of the scrub position, cut out of its
 * sheet ([trickplayFrame], [sheetUrl]). Sheets come through [images] (same origin only, memory-cached, so scrubbing within a
 * sheet loads it once); only the newest request may show. The view's width (168 dp) is set by the layout.
 */
class TrickplayPreview(private val view: ImageView, private val images: ImageLoader, private val scope: CoroutineScope) {
    private var job: Job? = null
    /** the frame on show (sheet URL and rectangle), so a move within one frame does nothing */
    private var shown: Pair<String, Frame>? = null

    fun show(info: TrickplayInfo, positionMs: Long) {
        if (!usable(info)) { hide(); return }
        val frame = trickplayFrame(info, positionMs)
        val url = sheetUrl(info, frame.sheet)
        view.visibility = View.VISIBLE
        if (shown == url to frame) return
        shown = url to frame
        job?.cancel()
        job = scope.launch {
            // full size: the frame's pixel rectangle is in the sheet's own coordinates
            val sheet = images.load(url, 0) ?: return@launch
            if (shown != url to frame) return@launch
            crop(sheet, frame)?.let(view::setImageBitmap)
        }
    }

    fun hide() {
        job?.cancel()
        job = null
        shown = null
        view.visibility = View.GONE
    }

    /** the frame's rectangle, cut to the sheet (the last sheet may hold fewer tiles) */
    private fun crop(sheet: Bitmap, f: Frame): Bitmap? {
        val w = minOf(f.width, sheet.width - f.x)
        val h = minOf(f.height, sheet.height - f.y)
        if (f.x < 0 || f.y < 0 || w <= 0 || h <= 0) return null
        return Bitmap.createBitmap(sheet, f.x, f.y, w, h)
    }

    companion object {
        /** the preview's width (web previewW) */
        const val WIDTH_DP = 168

        /** [trickplayFrame] clamps but can give a zero-size frame: no preview for such an info */
        fun usable(i: TrickplayInfo): Boolean = i.width > 0 && i.height > 0 && i.count > 0 && i.intervalMs > 0 && i.tileWidth > 0 && i.tileHeight > 0
    }
}
