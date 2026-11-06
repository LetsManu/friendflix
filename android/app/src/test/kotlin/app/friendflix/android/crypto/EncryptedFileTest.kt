// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import app.friendflix.android.crypto.EncryptedFormat.CHUNK_SIZE
import app.friendflix.android.crypto.EncryptedFormat.HEADER_SIZE
import app.friendflix.android.crypto.EncryptedFormat.TAG_SIZE
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Random
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EncryptedFileTest {
    @get:Rule val tmp = TemporaryFolder()
    private val keys = TestKeys()
    private val rnd = Random(42)
    private val record = (CHUNK_SIZE + TAG_SIZE).toLong()

    private fun bytes(n: Int) = ByteArray(n).also { rnd.nextBytes(it) }

    /** Appends in irregular pieces so chunk boundaries fall inside append calls. */
    private fun appendAll(w: EncryptedWriter, data: ByteArray, from: Int = 0) {
        var off = from
        while (off < data.size) {
            val n = minOf(data.size - off, 1 + rnd.nextInt(300_000))
            w.append(data, off, n)
            off += n
        }
    }

    private fun write(data: ByteArray, name: String = "f.ffe", k: KeyProvider = keys): File {
        val f = File(tmp.root, name)
        EncryptedWriter(f, k).use { w -> appendAll(w, data); w.finish() }
        return f
    }

    private fun readAll(f: File, k: KeyProvider = keys): ByteArray = EncryptedReader(f, k).use { r ->
        val out = ByteArray(r.length.toInt())
        var pos = 0
        while (pos < out.size) {
            val n = r.read(pos.toLong(), out, pos, minOf(out.size - pos, 77_777))
            assertTrue(n > 0)
            pos += n
        }
        assertEquals(-1, r.read(r.length, ByteArray(1), 0, 1))
        out
    }

    private fun expectIo(message: String, block: () -> Unit) {
        val e = assertThrows(IOException::class.java) { block() }
        assertEquals(message, e.message)
    }

    private fun patch(f: File, pos: Long, block: (Byte) -> Byte) = RandomAccessFile(f, "rw").use {
        it.seek(pos); val b = it.readByte(); it.seek(pos); it.writeByte(block(b).toInt())
    }

    private fun chunkOf(f: File, index: Int, len: Int = CHUNK_SIZE): ByteArray = EncryptedReader(f, keys).use { r ->
        ByteArray(len).also { assertEquals(len, r.read(index.toLong() * CHUNK_SIZE, it, 0, len)) }
    }

    @Test fun roundTripSizes() {
        for (size in listOf(0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 2 * CHUNK_SIZE, 10 * CHUNK_SIZE)) {
            val data = bytes(size)
            val f = write(data, "rt-$size")
            val full = size / CHUNK_SIZE
            val last = size % CHUNK_SIZE
            assertEquals("size formula for $size", HEADER_SIZE + full * record + last + TAG_SIZE, f.length())
            EncryptedReader(f, keys).use { assertEquals(size.toLong(), it.length) }
            assertArrayEquals("round trip $size", data, readAll(f))
        }
    }

    @Test fun headerLayout() {
        val f = write(bytes(10))
        val raw = f.readBytes()
        assertEquals("FFE1", String(raw, 0, 4, Charsets.US_ASCII))
        assertEquals(1, raw[4].toInt())
        assertEquals(CHUNK_SIZE, ByteBuffer.wrap(raw, 5, 4).int)
        assertEquals(25, HEADER_SIZE)
        assertEquals(1_048_576, CHUNK_SIZE)
    }

    @Test fun ciphertextIsNotPlaintextAndIvIsFreshPerFile() {
        val data = ByteArray(5000) // zeros: CTR output would equal the keystream
        val a = write(data, "a").readBytes()
        val b = write(data, "b").readBytes()
        assertFalse(a.copyOfRange(9, 25).contentEquals(b.copyOfRange(9, 25)))
        assertFalse(a.copyOfRange(HEADER_SIZE, HEADER_SIZE + 5000).contentEquals(b.copyOfRange(HEADER_SIZE, HEADER_SIZE + 5000)))
        assertFalse(a.copyOfRange(HEADER_SIZE, HEADER_SIZE + 5000).contentEquals(data))
    }

    @Test fun randomAccessReads() {
        val data = bytes(10 * CHUNK_SIZE + 12345)
        val f = write(data)
        EncryptedReader(f, keys).use { r ->
            repeat(100) {
                val pos = rnd.nextInt(data.size)
                val len = 1 + rnd.nextInt(3 * CHUNK_SIZE)
                val buf = ByteArray(len + 3)
                val n = r.read(pos.toLong(), buf, 3, len)
                val expected = minOf(len, data.size - pos)
                assertEquals(expected, n)
                assertArrayEquals(data.copyOfRange(pos, pos + n), buf.copyOfRange(3, 3 + n))
            }
        }
    }

    @Test fun readingPastEnd() {
        val data = bytes(CHUNK_SIZE + 10)
        val f = write(data)
        EncryptedReader(f, keys).use { r ->
            val buf = ByteArray(100)
            assertEquals(1, r.read(r.length - 1, buf, 0, 100))
            assertEquals(data.last(), buf[0])
            assertEquals(-1, r.read(r.length, buf, 0, 100))
            assertEquals(-1, r.read(r.length + 5000, buf, 0, 100))
            assertEquals(0, r.read(0, buf, 0, 0))
        }
        EncryptedReader(write(ByteArray(0), "empty"), keys).use { assertEquals(-1, it.read(0, ByteArray(1), 0, 1)) }
    }

    @Test fun flippedCiphertextByteFailsThatChunkOnly() {
        val data = bytes(3 * CHUNK_SIZE + 100)
        val f = write(data)
        patch(f, HEADER_SIZE + record + 4242) { (it.toInt() xor 1).toByte() }
        EncryptedReader(f, keys).use { r ->
            val buf = ByteArray(10)
            expectIo("integrity") { r.read(CHUNK_SIZE + 5L, buf, 0, 10) }
            // Neighbouring chunks are still fine.
            assertEquals(10, r.read(5, buf, 0, 10))
            assertArrayEquals(data.copyOfRange(5, 15), buf)
            assertEquals(10, r.read(2L * CHUNK_SIZE + 5, buf, 0, 10))
            // A read that spans into the bad chunk fails too: no plaintext of it is returned.
            expectIo("integrity") { r.read(CHUNK_SIZE - 5L, buf, 0, 10) }
        }
    }

    @Test fun flippedTagOrFinalChunkFails() {
        val f = write(bytes(CHUNK_SIZE + 1))
        patch(f, HEADER_SIZE + CHUNK_SIZE.toLong() + 3) { (it.toInt() xor 0x80).toByte() } // tag of chunk 0
        EncryptedReader(f, keys).use { r -> expectIo("integrity") { r.read(0, ByteArray(1), 0, 1) } }

        val g = write(bytes(CHUNK_SIZE + 1), "g")
        patch(g, HEADER_SIZE + record) { (it.toInt() xor 1).toByte() } // the single byte of the final chunk
        expectIo("integrity") { EncryptedReader(g, keys) }

        val h = write(bytes(100), "h")
        patch(h, 12) { (it.toInt() xor 1).toByte() } // the file IV
        expectIo("integrity") { EncryptedReader(h, keys) }
    }

    @Test fun otherKeysFail() {
        val f = write(bytes(2 * CHUNK_SIZE + 7))
        expectIo("integrity") { EncryptedReader(f, TestKeys()) }
        // Same MAC key, other AES key: tags still verify, plaintext differs. The MAC key is what guards integrity.
        val sameMac = TestKeys(macKey = keys.macKey())
        val other = EncryptedReader(f, sameMac).use { r -> ByteArray(16).also { r.read(0, it, 0, 16) } }
        assertFalse(other.contentEquals(chunkOf(f, 0, 16)))
    }

    @Test fun truncatedFileIsIncomplete() {
        val data = bytes(2 * CHUNK_SIZE + 5)
        val f = write(data)
        RandomAccessFile(f, "rw").use { it.setLength(HEADER_SIZE + 2 * record) } // final record gone
        expectIo("incomplete") { EncryptedReader(f, keys) }
        RandomAccessFile(f, "rw").use { it.setLength(HEADER_SIZE + 2 * record + TAG_SIZE - 1) }
        expectIo("incomplete") { EncryptedReader(f, keys) }
        RandomAccessFile(f, "rw").use { it.setLength(HEADER_SIZE.toLong()) }
        expectIo("incomplete") { EncryptedReader(f, keys) }
        RandomAccessFile(f, "rw").use { it.setLength(HEADER_SIZE - 1L) }
        expectIo("incomplete") { EncryptedReader(f, keys) }

        // An exact multiple of the chunk size still ends with an (empty) final record; without it the file is incomplete.
        val g = write(bytes(2 * CHUNK_SIZE), "g")
        RandomAccessFile(g, "rw").use { it.setLength(it.length() - TAG_SIZE) }
        expectIo("incomplete") { EncryptedReader(g, keys) }

        // An unfinished writer's file (crash before finish) is not readable either.
        val h = File(tmp.root, "h")
        EncryptedWriter(h, keys).use { it.append(bytes(3 * CHUNK_SIZE)) }
        expectIo("incomplete") { EncryptedReader(h, keys) }
    }

    @Test fun notAnEncryptedFile() {
        val f = tmp.newFile("plain")
        f.writeBytes(bytes(5000))
        expectIo("format") { EncryptedReader(f, keys) }
    }

    @Test fun swappedRecordsFail() {
        val f = write(bytes(3 * CHUNK_SIZE + 9))
        val raw = f.readBytes()
        val r0 = raw.copyOfRange(HEADER_SIZE, (HEADER_SIZE + record).toInt())
        val r1 = raw.copyOfRange((HEADER_SIZE + record).toInt(), (HEADER_SIZE + 2 * record).toInt())
        r1.copyInto(raw, HEADER_SIZE)
        r0.copyInto(raw, (HEADER_SIZE + record).toInt())
        f.writeBytes(raw)
        EncryptedReader(f, keys).use { r ->
            expectIo("integrity") { r.read(0, ByteArray(1), 0, 1) }
            expectIo("integrity") { r.read(CHUNK_SIZE.toLong(), ByteArray(1), 0, 1) }
        }
    }

    @Test fun recordFromAnotherFileFails() {
        val data = bytes(2 * CHUNK_SIZE + 9)
        val a = write(data, "a")
        val b = write(data, "b") // same keys, same plaintext, different IV
        val rawA = a.readBytes()
        val rawB = b.readBytes()
        rawB.copyInto(rawA, HEADER_SIZE, HEADER_SIZE, (HEADER_SIZE + record).toInt())
        a.writeBytes(rawA)
        EncryptedReader(a, keys).use { r -> expectIo("integrity") { r.read(0, ByteArray(1), 0, 1) } }
    }

    @Test fun resumeAfterCrashAtChunkBoundary() {
        val data = bytes(4 * CHUNK_SIZE + 333)
        val f = File(tmp.root, "f")
        EncryptedWriter(f, keys).use { w ->
            assertEquals(0, w.resumeOffset())
            w.append(data, 0, 2 * CHUNK_SIZE) // two full records hit the disk; then the process dies
        }
        assertEquals(HEADER_SIZE + 2 * record, f.length())
        EncryptedWriter(f, keys).use { w ->
            assertEquals(2L * CHUNK_SIZE, w.resumeOffset())
            appendAll(w, data, 2 * CHUNK_SIZE)
            w.finish()
        }
        assertArrayEquals(data, readAll(f))
    }

    @Test fun resumeAfterCrashMidRecordDropsBufferedAndPartialBytes() {
        val data = bytes(4 * CHUNK_SIZE + 333)
        val f = File(tmp.root, "f")
        EncryptedWriter(f, keys).use { w -> w.append(data, 0, 2 * CHUNK_SIZE + 500_000) } // 500 000 buffered bytes are lost
        RandomAccessFile(f, "rw").use { it.seek(it.length()); it.write(bytes(700_000)) } // a torn third record
        EncryptedWriter(f, keys).use { w ->
            assertEquals(2L * CHUNK_SIZE, w.resumeOffset())
            assertEquals(HEADER_SIZE + 2 * record, f.length())
            appendAll(w, data, 2 * CHUNK_SIZE)
            w.finish()
        }
        assertArrayEquals(data, readAll(f))
    }

    @Test fun resumeSkipsAGarbageLastRecord() {
        val data = bytes(3 * CHUNK_SIZE + 1)
        val f = File(tmp.root, "f")
        EncryptedWriter(f, keys).use { w -> w.append(data, 0, 3 * CHUNK_SIZE) }
        // Power loss: the file grew but the last record's data never reached the disk.
        RandomAccessFile(f, "rw").use { it.seek(HEADER_SIZE + 2 * record); it.write(ByteArray(record.toInt())) }
        EncryptedWriter(f, keys).use { w ->
            assertEquals(2L * CHUNK_SIZE, w.resumeOffset())
            appendAll(w, data, 2 * CHUNK_SIZE)
            w.finish()
        }
        assertArrayEquals(data, readAll(f))
    }

    @Test fun resumeAfterCrashMidHeaderStartsOver() {
        val data = bytes(CHUNK_SIZE + 3)
        val f = File(tmp.root, "f")
        f.writeBytes(byteArrayOf('F'.code.toByte(), 'F'.code.toByte(), 'E'.code.toByte(), '1'.code.toByte(), 1, 0, 0x10))
        EncryptedWriter(f, keys).use { w ->
            assertEquals(0, w.resumeOffset())
            appendAll(w, data)
            w.finish()
        }
        assertArrayEquals(data, readAll(f))
    }

    @Test fun resumeWithOtherKeysStartsOverWithANewIv() {
        val data = bytes(2 * CHUNK_SIZE + 3)
        val f = File(tmp.root, "f")
        EncryptedWriter(f, keys).use { w -> w.append(data, 0, 2 * CHUNK_SIZE) }
        val oldIv = f.readBytes().copyOfRange(9, 25)
        val newKeys = TestKeys()
        EncryptedWriter(f, newKeys).use { w ->
            assertEquals(0, w.resumeOffset())
            appendAll(w, data)
            w.finish()
        }
        assertFalse(oldIv.contentEquals(f.readBytes().copyOfRange(9, 25)))
        assertArrayEquals(data, readAll(f, newKeys))
    }

    @Test fun reopeningAFinishedFile() {
        val data = bytes(CHUNK_SIZE + 77)
        val f = write(data)
        val before = f.readBytes()
        EncryptedWriter(f, keys).use { w ->
            assertTrue(w.isComplete)
            assertEquals(data.size.toLong(), w.resumeOffset())
            assertThrows(IllegalStateException::class.java) { w.append(byteArrayOf(1)) }
            w.finish() // no-op
        }
        assertArrayEquals(before, f.readBytes())
    }

    @Test fun appendAfterFinishFails() {
        val f = File(tmp.root, "f")
        val w = EncryptedWriter(f, keys)
        w.append(bytes(10))
        w.finish()
        try { w.append(bytes(1)); fail() } catch (_: IllegalStateException) {}
    }

    @Test fun resumeOffsetTracksAppends() {
        EncryptedWriter(File(tmp.root, "f"), keys).use { w ->
            w.append(bytes(CHUNK_SIZE + 10))
            assertEquals(CHUNK_SIZE + 10L, w.resumeOffset())
        }
    }

    private fun fixedIv() = object : SecureRandom() {
        override fun nextBytes(bytes: ByteArray) { bytes.fill(0x5A) }
    }

    @Test fun resumedFileIsByteIdenticalToAnUninterruptedWrite() {
        val data = bytes(3 * CHUNK_SIZE + 999)
        val straight = File(tmp.root, "straight")
        EncryptedWriter(straight, keys, fixedIv()).use { appendAll(it, data); it.finish() }
        val resumed = File(tmp.root, "resumed")
        EncryptedWriter(resumed, keys, fixedIv()).use { it.append(data, 0, 2 * CHUNK_SIZE + 12345) }
        RandomAccessFile(resumed, "rw").use { it.seek(it.length()); it.write(bytes(5000)) }
        EncryptedWriter(resumed, keys, fixedIv()).use { w ->
            assertEquals(2L * CHUNK_SIZE, w.resumeOffset())
            appendAll(w, data, 2 * CHUNK_SIZE)
            w.finish()
        }
        assertArrayEquals(straight.readBytes(), resumed.readBytes())
        assertArrayEquals(readAll(straight), readAll(resumed))
    }

    private fun crashedWithGarbageTail(name: String, records: Int, garbage: Int): File {
        val f = File(tmp.root, name)
        EncryptedWriter(f, keys).use { it.append(bytes(records * CHUNK_SIZE)) }
        RandomAccessFile(f, "rw").use { raf ->
            for (i in records - garbage until records) { raf.seek(HEADER_SIZE + i * record); raf.write(ByteArray(CHUNK_SIZE)) }
        }
        return f
    }

    @Test fun resumeDropsExactlyMaxBacktrackRecords() {
        assertEquals(8, EncryptedWriter.MAX_BACKTRACK)
        val f = crashedWithGarbageTail("f", 10, EncryptedWriter.MAX_BACKTRACK)
        val iv = f.readBytes().copyOfRange(9, 25)
        EncryptedWriter(f, keys).use { w -> assertEquals(2L * CHUNK_SIZE, w.resumeOffset()) }
        assertEquals(HEADER_SIZE + 2 * record, f.length())
        assertArrayEquals(iv, f.readBytes().copyOfRange(9, 25))
    }

    @Test fun resumeBeyondMaxBacktrackStartsOverWithAFreshHeader() {
        val f = crashedWithGarbageTail("f", 10, EncryptedWriter.MAX_BACKTRACK + 1)
        val iv = f.readBytes().copyOfRange(9, 25)
        val data = bytes(CHUNK_SIZE + 5)
        EncryptedWriter(f, keys).use { w ->
            assertEquals(0, w.resumeOffset())
            assertEquals(HEADER_SIZE.toLong(), f.length())
            appendAll(w, data)
            w.finish()
        }
        val raw = f.readBytes()
        assertEquals("FFE1", String(raw, 0, 4, Charsets.US_ASCII))
        assertFalse(iv.contentEquals(raw.copyOfRange(9, 25)))
        assertArrayEquals(data, readAll(f))
    }

    @Test fun writerIsUnusableAfterAFailure() {
        val badKeys = TestKeys(key = SecretKeySpec(ByteArray(5), "AES"), macKey = keys.macKey()) // fails on the first record
        val w = EncryptedWriter(File(tmp.root, "f"), badKeys)
        w.append(bytes(10)) // buffered only
        assertThrows(java.security.GeneralSecurityException::class.java) { w.append(bytes(CHUNK_SIZE)) }
        assertThrows(IllegalStateException::class.java) { w.append(bytes(1)) }
        assertThrows(IllegalStateException::class.java) { w.finish() }
        w.close()
    }

    @Test fun changedHeaderFieldsAreRejectedAsFormat() {
        val f = write(bytes(100))
        patch(f, 4) { 2 } // version
        expectIo("format") { EncryptedReader(f, keys) }
        val g = write(bytes(100), "g")
        patch(g, 7) { 0x08 } // chunk size 0x00100800: a multiple of 16, but not 1 MiB
        expectIo("format") { EncryptedReader(g, keys) }
    }

    @Test fun tornFinalRecordOfAtLeastATagIsIntegrity() {
        // A final record cut short but still >= 32 bytes cannot be told apart from a tampered one: "integrity", not "incomplete".
        val f = write(bytes(2 * CHUNK_SIZE + 100))
        RandomAccessFile(f, "rw").use { it.setLength(it.length() - 50) }
        expectIo("integrity") { EncryptedReader(f, keys) }
    }

    @Test fun counterIs128BitBigEndianAddWithCarry() {
        val iv = ByteArray(16) { 0xFF.toByte() }.also { it[0] = 0x12 }
        val c = EncryptedFormat.counter(iv, 1)
        assertArrayEquals(ByteArray(16).also { it[0] = 0x13 }, c)
        assertArrayEquals(ByteArray(16), EncryptedFormat.counter(ByteArray(16) { 0xFF.toByte() }, 1)) // wraps mod 2^128
        val big = EncryptedFormat.counter(ByteArray(16), Long.MAX_VALUE)
        assertArrayEquals(ByteArray(8) + byteArrayOf(0x7F, -1, -1, -1, -1, -1, -1, -1), big)

        // The per-chunk counter matches one continuous CTR stream (the JCE also increments over all 128 bits).
        val key = SecretKeySpec(TestKeys.random(32), "AES")
        val start = ByteArray(16) { 0xFF.toByte() }.also { it[0] = 0; it[15] = 0xF0.toByte() }
        val blocks = 64
        val zeros = ByteArray(2 * blocks * 16)
        val stream = Cipher.getInstance("AES/CTR/NoPadding").run { init(Cipher.ENCRYPT_MODE, key, IvParameterSpec(start)); doFinal(zeros) }
        val second = Cipher.getInstance("AES/CTR/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, key, IvParameterSpec(EncryptedFormat.counter(start, blocks.toLong())))
            doFinal(ByteArray(blocks * 16))
        }
        assertArrayEquals(stream.copyOfRange(blocks * 16, 2 * blocks * 16), second)
    }
}
