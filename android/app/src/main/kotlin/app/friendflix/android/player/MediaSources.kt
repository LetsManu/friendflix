// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import app.friendflix.android.crypto.EncryptedDataSource
import app.friendflix.android.crypto.KeyProvider
import okhttp3.OkHttpClient
import java.io.File

/**
 * Media sources of the player. Streams go through the origin-only cookie client of `ServerApi` (media3-datasource-okhttp), HLS when
 * the server answers with its HLS URL, the direct-play URL as a progressive file otherwise. Downloads are read through
 * [EncryptedDataSource] (video and its encrypted text subtitles); nothing is ever decrypted to disk.
 */
@OptIn(UnstableApi::class)
object MediaSources {
    fun network(client: OkHttpClient): MediaSource.Factory = DefaultMediaSourceFactory(OkHttpDataSource.Factory(client))

    fun encrypted(keys: KeyProvider): MediaSource.Factory = DefaultMediaSourceFactory(EncryptedDataSource.Factory(keys))

    /** A stream: [hls] = the server's HLS master playlist; [subtitles] side-loaded WebVTT (id `sub-<index>`). */
    fun streamItem(url: Uri, hls: Boolean, subtitles: List<MediaItem.SubtitleConfiguration>, meta: MediaMetadata): MediaItem =
        MediaItem.Builder()
            .setUri(url)
            .apply { if (hls) setMimeType(MimeTypes.APPLICATION_M3U8) }
            .setSubtitleConfigurations(subtitles)
            .setMediaMetadata(meta)
            .build()

    fun webVtt(url: Uri, index: Int, language: String?, label: String?): MediaItem.SubtitleConfiguration =
        MediaItem.SubtitleConfiguration.Builder(url)
            .setId(subtitleId(index))
            .setMimeType(MimeTypes.TEXT_VTT)
            .setLanguage(language)
            .setLabel(label)
            .build()

    /** A downloaded title: the encrypted video file and its encrypted text subtitles (language, `.vtt` / `.srt` file). */
    fun localItem(video: File, subtitles: List<Pair<String, File>>, meta: MediaMetadata): MediaItem =
        MediaItem.Builder()
            .setUri(Uri.fromFile(video))
            .setSubtitleConfigurations(
                subtitles.mapIndexed { i, (lang, file) ->
                    MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(file))
                        .setId(subtitleId(i))
                        .setMimeType(subtitleMime(file.name))
                        .setLanguage(lang)
                        .setLabel(lang)
                        .build()
                },
            )
            .setMediaMetadata(meta)
            .build()

    fun subtitleId(index: Int) = "sub-$index"

    /** `.srt` → SubRip, everything else the downloader stores (`.vtt`) → WebVTT. */
    fun subtitleMime(name: String): String = if (name.lowercase().endsWith(".srt")) MimeTypes.APPLICATION_SUBRIP else MimeTypes.TEXT_VTT
}
