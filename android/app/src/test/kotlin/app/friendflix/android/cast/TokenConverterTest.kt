// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaTrack
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The receiver's item is the server's cast token answer as web lib/cast.ts `mediaOf` / `loadOnCast` sends it: content id = the
 * server's content URL, subtitles = the server's signed WebVTT URLs, `customData.ff.castId` only for the own receiver, and the report
 * token never in the media.
 */
@RunWith(RobolectricTestRunner::class)
class TokenConverterTest {
    private val answer = JSONObject(
        """{"castId":"0123456789abcdef0123456789abcdef","expiresAt":1700000000000,"playSessionId":"ps1","mediaSourceId":"ms1",
        "runtimeTicks":27000000000,"startTime":61,"contentUrl":"https://ff.example/media/c/TOKEN/videos/x/master.m3u8?MediaSourceId=ms1",
        "contentType":"application/x-mpegURL","hlsSegmentFormat":"ts","title":"Second","seriesName":"Bright Valley",
        "imageUrl":"https://ff.example/media/c/IMG/Items/x/Images/Primary?maxWidth=600",
        "subtitles":[{"index":3,"language":"eng","title":"English","url":"https://ff.example/api/cast/subtitle/a/b/1/s/x/ms/3/stream.vtt"},
        {"index":5,"title":"Deutsch","url":"https://ff.example/api/cast/subtitle/a/b/1/s/x/ms/5/stream.vtt"}],"report":"REPORT-TOKEN"}""",
    )
    private val info = CastInfo.parse(answer)!!

    @Test fun theServersUrlsGoToTheReceiverUnchanged() {
        val q = TokenConverter.queueItem(info, subIndex = 5, autoplay = true, custom = false)
        val m = q.media!!
        assertEquals(answer.getString("contentUrl"), m.contentId)
        assertEquals(MediaInfo.STREAM_TYPE_BUFFERED, m.streamType)
        assertEquals("application/x-mpegURL", m.contentType)
        assertEquals(2_700_000L, m.streamDuration)
        assertEquals(listOf(answer.getJSONArray("subtitles").getJSONObject(0).getString("url"), answer.getJSONArray("subtitles").getJSONObject(1).getString("url")), m.mediaTracks!!.map { it.contentId })
        assertEquals(listOf("en", "und"), m.mediaTracks!!.map { it.language })
        assertEquals(MediaTrack.SUBTYPE_SUBTITLES, m.mediaTracks!![0].subtype)
        assertArrayEquals(longArrayOf(2), q.activeTrackIds)
        assertEquals(61.0, q.startTime, 0.0)
        assertEquals(TokenConverter.PRELOAD_S, q.preloadTime, 0.0)
        val meta = m.metadata!!
        assertEquals(MediaMetadata.MEDIA_TYPE_TV_SHOW, meta.mediaType)
        assertEquals("Second", meta.getString(MediaMetadata.KEY_TITLE))
        assertEquals("Bright Valley", meta.getString(MediaMetadata.KEY_SERIES_TITLE))
        assertEquals(answer.getString("imageUrl"), meta.images[0].url.toString())
        // the Default Media Receiver gets no custom data; the report token is nowhere in the item
        assertNull(m.customData)
        assertFalse(q.toJson().toString().contains("REPORT-TOKEN"))
    }

    @Test fun theOwnReceiverGetsTheCastIdOnly() {
        val q = TokenConverter.queueItem(info, subIndex = null, autoplay = false, custom = true)
        assertEquals("""{"ff":{"castId":"0123456789abcdef0123456789abcdef"}}""", q.media!!.customData.toString())
        assertNull(q.activeTrackIds)
        assertFalse(q.autoplay)
        assertFalse(q.toJson().toString().contains("REPORT-TOKEN"))
    }

    @Test fun receiverItemsMapBackToTheirToken() {
        val c = TokenConverter(custom = false)
        val item = c.item(info, null, true)
        assertEquals(info.castId, item.mediaId)
        val q = c.toMediaQueueItem(item)
        assertEquals(info.castId, c.toMediaItem(q).mediaId)
        val foreign = TokenConverter.queueItem(CastInfo.parse(JSONObject(answer.toString()).put("castId", "f".repeat(32)).put("contentUrl", "https://other.example/x.m3u8"))!!, null, true, false)
        assertEquals(TokenConverter.FOREIGN, c.toMediaItem(foreign).mediaId)
    }

    @Test fun castInfoNeverPrintsItsUrls() {
        assertFalse(info.toString().contains("ff.example"))
        assertFalse(info.toString().contains("REPORT"))
    }
}
