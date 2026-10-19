// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import app.friendflix.android.crypto.EncryptedFormat.CHUNK_SIZE
import app.friendflix.android.crypto.EncryptedFormat.HEADER_SIZE
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@androidx.annotation.OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class EncryptedDataSourceTest {
    @get:Rule val tmp = TemporaryFolder()
    private val keys = TestKeys()
    private val rnd = Random(7)
    private lateinit var data: ByteArray
    private lateinit var file: File
    private lateinit var uri: Uri

    @Before fun write() {
        data = ByteArray(3 * CHUNK_SIZE + 4321).also { rnd.nextBytes(it) }
        file = File(tmp.root, "movie.ffe")
        EncryptedWriter(file, keys).use { it.append(data); it.finish() }
        uri = Uri.fromFile(file)
    }

    private fun drain(ds: EncryptedDataSource): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(1 + rnd.nextInt(200_000))
        while (true) {
            val n = ds.read(buf, 0, buf.size)
            if (n == C.RESULT_END_OF_INPUT) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    @Test fun wholeFileWithUnsetLength() {
        val ds = EncryptedDataSource(keys)
        assertEquals(data.size.toLong(), ds.open(DataSpec(uri)))
        assertEquals(uri, ds.uri)
        assertArrayEquals(data, drain(ds))
        assertEquals(C.RESULT_END_OF_INPUT, ds.read(ByteArray(10), 0, 10))
        ds.close()
        assertNull(ds.uri)
    }

    @Test fun randomPositionsAndLengthsMatchPlaintextSlices() {
        val ds = EncryptedDataSource(keys)
        repeat(60) {
            val pos = rnd.nextInt(data.size + 1)
            val bounded = rnd.nextBoolean()
            val len = if (bounded) rnd.nextInt(data.size - pos + 1).toLong() else C.LENGTH_UNSET.toLong()
            val spec = DataSpec.Builder().setUri(uri).setPosition(pos.toLong()).setLength(len).build()
            val opened = ds.open(spec)
            val expectedLen = if (bounded) len.toInt() else data.size - pos
            assertEquals(expectedLen.toLong(), opened)
            assertArrayEquals(data.copyOfRange(pos, pos + expectedLen), drain(ds))
            ds.close()
        }
    }

    @Test fun zeroLengthReadAndEndOfInput() {
        val ds = EncryptedDataSource(keys)
        assertEquals(0L, ds.open(DataSpec.Builder().setUri(uri).setPosition(data.size.toLong()).build()))
        assertEquals(0, ds.read(ByteArray(4), 0, 0))
        assertEquals(C.RESULT_END_OF_INPUT, ds.read(ByteArray(4), 0, 4))
        ds.close()
    }

    @Test fun lengthBeyondEndStopsAtEndOfFile() {
        val ds = EncryptedDataSource(keys)
        val pos = data.size - 100L
        ds.open(DataSpec.Builder().setUri(uri).setPosition(pos).setLength(1000).build())
        assertArrayEquals(data.copyOfRange(pos.toInt(), data.size), drain(ds))
        ds.close()
    }

    @Test fun positionPastEndIsOutOfRange() {
        val ds = EncryptedDataSource(keys)
        val e = assertThrows(DataSourceException::class.java) {
            ds.open(DataSpec.Builder().setUri(uri).setPosition(data.size + 1L).build())
        }
        assertEquals(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE, e.reason)
        ds.close()
    }

    @Test fun tamperedChunkSurfacesAsIOException() {
        RandomAccessFile(file, "rw").use { it.seek(HEADER_SIZE + 10L); val b = it.readByte(); it.seek(HEADER_SIZE + 10L); it.writeByte(b.toInt() xor 2) }
        val ds = EncryptedDataSource(keys)
        ds.open(DataSpec(uri))
        val e = assertThrows(IOException::class.java) { ds.read(ByteArray(100), 0, 100) }
        assertEquals("integrity", e.message)
        ds.close()
    }

    @Test fun incompleteFileFailsOnOpen() {
        RandomAccessFile(file, "rw").use { it.setLength(HEADER_SIZE + 2L * (CHUNK_SIZE + EncryptedFormat.TAG_SIZE)) }
        val ds = EncryptedDataSource(keys)
        val e = assertThrows(IOException::class.java) { ds.open(DataSpec(uri)) }
        assertEquals("incomplete", e.message)
        ds.close()
    }

    @Test fun otherSchemesAreRejected() {
        val ds = EncryptedDataSource(keys)
        for (u in listOf("https://example.invalid/movie.ffe", "content://x/movie.ffe")) {
            assertThrows(DataSourceException::class.java) { ds.open(DataSpec(Uri.parse(u))) }
            ds.close()
        }
        // A bare path (no scheme) is accepted.
        assertEquals(data.size.toLong(), ds.open(DataSpec(Uri.parse(file.absolutePath))))
        ds.close()
    }

    @Test fun factoryCreatesSources() {
        val ds = EncryptedDataSource.Factory(keys).createDataSource()
        ds.open(DataSpec(uri))
        val buf = ByteArray(16)
        assertEquals(16, ds.read(buf, 0, 16))
        assertArrayEquals(data.copyOfRange(0, 16), buf)
        ds.close()
    }
}
