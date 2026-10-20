// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import java.io.File
import java.io.IOException

/**
 * Media3 [DataSource] over an FFE1 file ([EncryptedReader]): `file://` URIs or bare paths only (other schemes are rejected). Decrypts on the fly; the
 * reader keeps the last verified chunk, so sequential reads verify each 1 MiB chunk once. Integrity failures surface as
 * `IOException("integrity")` / `IOException("incomplete")` from [open] or [read], which the player reports as a playback error.
 *
 * Semantics follow FileDataSource: [open] returns the bytes that will be read (`dataSpec.length` if set, otherwise
 * `length - position`); a position past the end throws [DataSourceException] with
 * [PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE]; a set length reaching past the end ends early with
 * [C.RESULT_END_OF_INPUT].
 */
@androidx.annotation.OptIn(UnstableApi::class)
class EncryptedDataSource(private val keys: KeyProvider) : BaseDataSource(/* isNetwork = */ false) {

    /** Factory for the player (Task 8): `ProgressiveMediaSource.Factory(EncryptedDataSource.Factory(keys))`. */
    class Factory(private val keys: KeyProvider) : DataSource.Factory {
        override fun createDataSource(): EncryptedDataSource = EncryptedDataSource(keys)
    }

    private var reader: EncryptedReader? = null
    private var uri: Uri? = null
    private var position = 0L
    private var bytesRemaining = 0L
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        val scheme = dataSpec.uri.scheme
        if (scheme != null && scheme != "file") {
            throw DataSourceException(IOException("unsupported scheme"), PlaybackException.ERROR_CODE_FAILED_RUNTIME_CHECK)
        }
        val path = dataSpec.uri.path ?: throw DataSourceException(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND)
        val r = try {
            EncryptedReader(File(path), keys)
        } catch (e: java.io.FileNotFoundException) {
            throw DataSourceException(e, PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND)
        }
        reader = r
        if (dataSpec.position > r.length) {
            throw DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE)
        }
        position = dataSpec.position
        bytesRemaining = if (dataSpec.length == C.LENGTH_UNSET.toLong()) r.length - position else dataSpec.length
        opened = true
        transferStarted(dataSpec)
        return bytesRemaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT
        val r = reader ?: throw IOException("not open")
        val n = r.read(position, buffer, offset, minOf(length.toLong(), bytesRemaining).toInt())
        if (n < 0) return C.RESULT_END_OF_INPUT
        position += n
        bytesRemaining -= n
        bytesTransferred(n)
        return n
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        uri = null
        try {
            reader?.close()
        } finally {
            reader = null
            if (opened) {
                opened = false
                transferEnded()
            }
        }
    }
}
