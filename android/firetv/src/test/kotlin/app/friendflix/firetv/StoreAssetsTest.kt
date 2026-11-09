// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv

import java.io.File
import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class StoreAssetsTest {
    private fun size(path: String): Pair<Int, Int> = File(path).readBytes().let { b ->
        val bb = ByteBuffer.wrap(b, 16, 8); bb.int to bb.int } // PNG IHDR width, height

    @Test fun storeImagesHaveTheirSizes() {
        assertEquals(512 to 512, size("store-listing/icon-512.png")); assertEquals(114 to 114, size("store-listing/icon-114.png"))
        assertEquals(1280 to 720, size("store-listing/banner-1280x720.png"))
        for (i in 1..3) assertEquals(1920 to 1080, size("store-listing/tv-$i.png"))
    }

    @Test fun templatesNameNoOtherServiceAndNoRealHost() {
        File("store-listing/src").listFiles()!!.filter { it.extension == "html" }.forEach { f ->
            val t = f.readText()
            assertFalse(f.name, Regex("(?i)netflix|plex|prime video|disney|hulu").containsMatchIn(t))
            assertFalse(f.name, Regex("https?://").containsMatchIn(t))
        }
    }
}
