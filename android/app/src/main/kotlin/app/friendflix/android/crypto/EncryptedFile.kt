// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec

/**
 * On-disk format of downloaded media ("FFE1"), encrypted at rest, seekable and tamper-evident.
 *
 * ```
 * header  = "FFE1" (4) ‖ version u8 (=1) ‖ chunkSize u32 BE (=1 MiB) ‖ fileIV (16, SecureRandom)      -- HEADER_SIZE = 25 bytes
 * body    = record*
 * record  = ciphertext chunk ‖ tag (32)
 * ```
 * Every record but the last carries exactly `chunkSize` ciphertext bytes. The last record ("final", isLast = 1) carries
 * `0 ≤ L < chunkSize` bytes; it is empty when the plaintext length is a multiple of `chunkSize`. A file is complete only when its last
 * record is a final one; [EncryptedReader] rejects anything else with `IOException("incomplete")`.
 *
 * - Cipher: AES-256-CTR (AES/CTR/NoPadding). Chunk `i` starts at counter `fileIV + i * (chunkSize / 16)` (128-bit big-endian add,
 *   mod 2^128); within the chunk the counter increments per 16-byte block as usual.
 * - Tag: `HMAC-SHA256(macKey, "FFE1" ‖ fileIV ‖ i u64 BE ‖ isLast u8 ‖ ciphertext)`. It binds the record to this file (IV), to its
 *   position (index) and marks the end (isLast), so records cannot be modified, reordered, moved between files, dropped or appended.
 *   Tags are compared in constant time and checked before any plaintext of the chunk is released.
 *
 * Lengths (R = chunkSize + TAG_SIZE, B = fileSize − HEADER_SIZE): a complete file has `n = B / R` full records followed by a final
 * record of `B % R` bytes, so `B % R ≥ TAG_SIZE` and **plaintext length = n · chunkSize + (B % R − TAG_SIZE)**. `B % R < TAG_SIZE`
 * means the final record is missing (incomplete). A torn final record that still has ≥ TAG_SIZE bytes fails its tag ("integrity").
 *
 * The header fields other than the IV are not covered by a tag; changing them changes the record layout or the counter, so the tags
 * fail. The plaintext length is not hidden (it is the file size minus overhead).
 */
object EncryptedFormat {
    const val VERSION: Int = 1
    const val CHUNK_SIZE: Int = 1 shl 20
    const val IV_SIZE: Int = 16
    const val TAG_SIZE: Int = 32
    const val HEADER_SIZE: Int = 4 + 1 + 4 + IV_SIZE

    internal val MAGIC: ByteArray = "FFE1".toByteArray(Charsets.US_ASCII)
    private const val BLOCK = 16
    internal const val CIPHER = "AES/CTR/NoPadding"
    internal const val MAC = "HmacSHA256"

    /** `iv + blocks` as a 128-bit big-endian unsigned add (mod 2^128). [blocks] must be ≥ 0. */
    fun counter(iv: ByteArray, blocks: Long): ByteArray {
        require(iv.size == IV_SIZE && blocks >= 0)
        val out = iv.copyOf()
        var carry = blocks
        var i = IV_SIZE - 1
        var c = 0L
        while (i >= 0 && (carry != 0L || c != 0L)) {
            val sum = (out[i].toLong() and 0xFF) + (carry and 0xFF) + c
            out[i] = sum.toByte()
            c = sum ushr 8
            carry = carry ushr 8
            i--
        }
        return out
    }

    internal fun header(chunkSize: Int, iv: ByteArray): ByteArray =
        ByteBuffer.allocate(HEADER_SIZE).put(MAGIC).put(VERSION.toByte()).putInt(chunkSize).put(iv).array()

    /** Parsed header (chunk size, IV), or null unless [bytes] is an FFE1 header with version 1 and chunk size [CHUNK_SIZE]. */
    internal fun parseHeader(bytes: ByteArray): Pair<Int, ByteArray>? {
        if (bytes.size < HEADER_SIZE) return null
        if (!bytes.copyOfRange(0, 4).contentEquals(MAGIC) || bytes[4].toInt() != VERSION) return null
        val chunkSize = ByteBuffer.wrap(bytes, 5, 4).int
        if (chunkSize != CHUNK_SIZE) return null
        return chunkSize to bytes.copyOfRange(9, 9 + IV_SIZE)
    }

    internal fun blocksPerChunk(chunkSize: Int): Long = (chunkSize / BLOCK).toLong()
}

/** Per-file crypto state shared by writer and reader: the CTR cipher, the MAC and how to compute a record's tag. */
private class RecordCrypto(keys: KeyProvider, private val iv: ByteArray, private val chunkSize: Int) {
    private val cipher: Cipher = Cipher.getInstance(EncryptedFormat.CIPHER)
    private val mac: Mac = Mac.getInstance(EncryptedFormat.MAC).apply { init(keys.macKey()) }
    private val key = keys.key()
    private val idx = ByteBuffer.allocate(8)

    /** CTR is symmetric: the same call encrypts or decrypts `len` bytes of chunk [index] from [src] into [dst]. */
    fun crypt(index: Long, src: ByteArray, len: Int, dst: ByteArray) {
        cipher.init(Cipher.ENCRYPT_MODE, key, IvParameterSpec(EncryptedFormat.counter(iv, index * EncryptedFormat.blocksPerChunk(chunkSize))))
        val n = cipher.doFinal(src, 0, len, dst, 0)
        check(n == len)
    }

    fun tag(index: Long, isLast: Boolean, ciphertext: ByteArray, len: Int): ByteArray {
        mac.update(EncryptedFormat.MAGIC)
        mac.update(iv)
        idx.clear()
        mac.update(idx.putLong(index).array())
        mac.update((if (isLast) 1 else 0).toByte())
        mac.update(ciphertext, 0, len)
        return mac.doFinal()
    }

    fun verify(index: Long, isLast: Boolean, ciphertext: ByteArray, len: Int, tag: ByteArray): Boolean =
        MessageDigest.isEqual(tag(index, isLast, ciphertext, len), tag)
}

private fun FileChannel.readFully(dst: ByteBuffer, position: Long) {
    var pos = position
    while (dst.hasRemaining()) {
        val n = read(dst, pos)
        if (n < 0) throw IOException("incomplete")
        pos += n
    }
}

private fun FileChannel.writeFully(src: ByteBuffer, position: Long) {
    var pos = position
    while (src.hasRemaining()) pos += write(src, pos)
}

/**
 * Writes an FFE1 file. Opening an existing file resumes it (see [resumeOffset]); a missing, empty or unparseable file (e.g. a crash
 * while writing the header) is started over with a fresh random IV.
 *
 * Plaintext is buffered up to one chunk; each full chunk is written as a record by [append]. [finish] writes the final record, fsyncs
 * and closes; only then is the file complete. [close] without [finish] (or a crash) loses the buffered, not yet written plaintext.
 *
 * Resuming (bounded work): the trailing partial record is cut off, then full records are verified from the last one backwards. At
 * most [MAX_BACKTRACK] unverifiable records (e.g. data that never reached the disk before a power loss) are dropped, so at most
 * MAX_BACKTRACK + 1 records are checked. Writing continues after the first record that verifies. If none does (more garbage than
 * that, no full record at all, or other keys), the file is started over: truncated, new header, new random IV. Records before the
 * verified one are not re-checked here; damage there is caught by the reader ("integrity").
 *
 * CTR safety: re-writing a dropped chunk reuses its key + counter. That is safe only because the caller re-fetches the *identical*
 * bytes (same licence file, HTTP Range from [resumeOffset]). The caller must guarantee that; different content (another file,
 * a changed source) must go to a new file / a new EncryptedWriter on a deleted file (new IV).
 *
 * Errors: any exception from [append] / [finish] (I/O, crypto) leaves the writer failed; further calls throw IllegalStateException.
 * On an IOException: [close], open a new EncryptedWriter on the same file and continue from its [resumeOffset].
 *
 * Not thread-safe; one writer per file.
 */
class EncryptedWriter internal constructor(file: File, keys: KeyProvider, random: SecureRandom) : Closeable {
    constructor(file: File, keys: KeyProvider) : this(file, keys, SecureRandom())

    private val chunkSize = EncryptedFormat.CHUNK_SIZE

    private val raf = RandomAccessFile(file, "rw")
    private val channel: FileChannel = raf.channel
    private val record = (chunkSize + EncryptedFormat.TAG_SIZE).toLong()
    private val buffer = ByteArray(chunkSize)
    private val out = ByteArray(chunkSize)
    private var buffered = 0
    private var nextIndex = 0L
    private var closed = false
    private var failed = false
    private val crypto: RecordCrypto

    /** True once the final record is on disk (after [finish], or when the opened file was already complete). */
    var isComplete: Boolean = false
        private set
    private var completeLength = 0L

    init {
        try {
            crypto = prepare(keys, random)
        } catch (e: Throwable) {
            raf.close()
            throw e
        }
    }

    /**
     * Plaintext offset of the next byte [append] expects: right after opening, the end of the last verified full record (0 for a new
     * file); the caller fetches the source from here (HTTP Range). For a complete file: its plaintext length.
     */
    fun resumeOffset(): Long = if (isComplete) completeLength else nextIndex * chunkSize + buffered

    fun append(bytes: ByteArray) = append(bytes, 0, bytes.size)

    fun append(bytes: ByteArray, off: Int, len: Int) {
        check(!isComplete && !closed && !failed) { "writer finished, closed or failed" }
        require(off >= 0 && len >= 0 && off + len <= bytes.size)
        failOnError { appendChunks(bytes, off, len) }
    }

    private fun appendChunks(bytes: ByteArray, off: Int, len: Int) {
        var o = off
        var left = len
        while (left > 0) {
            val n = minOf(left, chunkSize - buffered)
            System.arraycopy(bytes, o, buffer, buffered, n)
            buffered += n
            o += n
            left -= n
            if (buffered == chunkSize) {
                writeRecord(isLast = false)
            }
        }
    }

    /** Writes the final record, fsyncs and closes. Idempotent on a complete file. */
    fun finish() {
        if (isComplete) {
            close()
            return
        }
        check(!closed && !failed) { "writer closed or failed" }
        failOnError {
            val total = nextIndex * chunkSize + buffered
            writeRecord(isLast = true)
            channel.force(true)
            completeLength = total
            isComplete = true
        }
        close()
    }

    /** After any failure the writer's on-disk state is unknown: it refuses further use (IllegalStateException). */
    private inline fun failOnError(block: () -> Unit) {
        try {
            block()
        } catch (e: Throwable) {
            failed = true
            throw e
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        buffer.fill(0)
        out.fill(0)
        raf.close()
    }

    private fun writeRecord(isLast: Boolean) {
        val len = buffered
        crypto.crypt(nextIndex, buffer, len, out)
        val tag = crypto.tag(nextIndex, isLast, out, len)
        val pos = EncryptedFormat.HEADER_SIZE + nextIndex * record
        channel.writeFully(ByteBuffer.wrap(out, 0, len), pos)
        channel.writeFully(ByteBuffer.wrap(tag), pos + len)
        nextIndex++
        buffered = 0
    }

    private fun prepare(keys: KeyProvider, random: SecureRandom): RecordCrypto {
        val size = channel.size()
        if (size >= EncryptedFormat.HEADER_SIZE) {
            val head = ByteBuffer.allocate(EncryptedFormat.HEADER_SIZE)
            channel.readFully(head, 0)
            val parsed = EncryptedFormat.parseHeader(head.array())
            if (parsed != null) {
                val iv = parsed.second
                val c = RecordCrypto(keys, iv, chunkSize)
                val body = size - EncryptedFormat.HEADER_SIZE
                val full = body / record
                val rest = (body % record).toInt()
                if (rest >= EncryptedFormat.TAG_SIZE && verifyAt(c, full, rest - EncryptedFormat.TAG_SIZE, isLast = true)) {
                    isComplete = true
                    completeLength = full * chunkSize + rest - EncryptedFormat.TAG_SIZE
                    nextIndex = full + 1
                    return c
                }
                // Drop at most MAX_BACKTRACK unverifiable trailing records, i.e. check at most MAX_BACKTRACK + 1.
                var keep = full
                var verified = false
                while (keep > 0 && full - keep <= MAX_BACKTRACK) {
                    if (verifyAt(c, keep - 1, chunkSize, isLast = false)) {
                        verified = true
                        break
                    }
                    keep--
                }
                if (verified) {
                    channel.truncate(EncryptedFormat.HEADER_SIZE + keep * record)
                    channel.force(true)
                    nextIndex = keep
                    return c
                }
            }
        }
        val iv = ByteArray(EncryptedFormat.IV_SIZE).also { random.nextBytes(it) }
        channel.truncate(0)
        channel.writeFully(ByteBuffer.wrap(EncryptedFormat.header(chunkSize, iv)), 0)
        channel.force(true)
        nextIndex = 0
        return RecordCrypto(keys, iv, chunkSize)
    }

    private fun verifyAt(c: RecordCrypto, index: Long, len: Int, isLast: Boolean): Boolean {
        val ct = ByteArray(len)
        val tag = ByteArray(EncryptedFormat.TAG_SIZE)
        val pos = EncryptedFormat.HEADER_SIZE + index * record
        channel.readFully(ByteBuffer.wrap(ct), pos)
        channel.readFully(ByteBuffer.wrap(tag), pos + len)
        return c.verify(index, isLast, ct, len, tag)
    }

    companion object {
        /** How many trailing full records resume may drop before it gives up and starts the file over. */
        const val MAX_BACKTRACK = 8
    }
}

/**
 * Random-access reader of a complete FFE1 file. Opening reads the header, derives [length] from the file size and verifies the final
 * record (so truncation is detected up front). Each chunk's tag is verified before any of its plaintext is returned; the last
 * decrypted chunk is cached, so sequential reads verify each chunk once.
 *
 * Errors: `IOException("format")` not an FFE1 v1 file; `IOException("incomplete")` no final record (unfinished or truncated file);
 * `IOException("integrity")` a tag mismatch (tampering, corruption, other keys). Thread-safe (reads are serialized).
 */
class EncryptedReader(file: File, keys: KeyProvider) : Closeable {
    private val raf = RandomAccessFile(file, "r")
    private val channel: FileChannel = raf.channel
    private val chunkSize: Int
    private val record: Long
    private val crypto: RecordCrypto
    private val lastIndex: Long
    private val lastLen: Int

    /** Plaintext length in bytes. */
    val length: Long

    private lateinit var ct: ByteArray
    private lateinit var plain: ByteArray
    private val tag = ByteArray(EncryptedFormat.TAG_SIZE)
    private var cachedIndex = -1L

    init {
        try {
            val size = channel.size()
            if (size < EncryptedFormat.HEADER_SIZE) throw IOException("incomplete")
            val head = ByteBuffer.allocate(EncryptedFormat.HEADER_SIZE)
            channel.readFully(head, 0)
            val (cs, iv) = EncryptedFormat.parseHeader(head.array()) ?: throw IOException("format")
            chunkSize = cs
            record = (cs + EncryptedFormat.TAG_SIZE).toLong()
            crypto = RecordCrypto(keys, iv, cs)
            val body = size - EncryptedFormat.HEADER_SIZE
            val rest = (body % record).toInt()
            if (rest < EncryptedFormat.TAG_SIZE) throw IOException("incomplete")
            lastIndex = body / record
            lastLen = rest - EncryptedFormat.TAG_SIZE
            length = lastIndex * cs + lastLen
            ct = ByteArray(cs)
            plain = ByteArray(cs)
            load(lastIndex)
        } catch (e: Throwable) {
            raf.close()
            throw e
        }
    }

    /**
     * Copies up to [len] plaintext bytes starting at [pos] into [buf] at [off]; may span chunks. Returns the number of bytes copied
     * (fewer than [len] only at the end of the file), 0 if [len] is 0, or -1 if [pos] ≥ [length].
     */
    @Synchronized
    fun read(pos: Long, buf: ByteArray, off: Int, len: Int): Int {
        require(pos >= 0 && off >= 0 && len >= 0 && off + len <= buf.size)
        if (len == 0) return 0
        if (pos >= length) return -1
        var p = pos
        var copied = 0
        while (copied < len && p < length) {
            val index = p / chunkSize
            load(index)
            val inChunk = (p - index * chunkSize).toInt()
            val available = chunkLen(index) - inChunk
            val n = minOf(available, len - copied)
            System.arraycopy(plain, inChunk, buf, off + copied, n)
            copied += n
            p += n
        }
        return copied
    }

    override fun close() {
        synchronized(this) {
            if (::plain.isInitialized) plain.fill(0)
            cachedIndex = -1
        }
        raf.close()
    }

    private fun chunkLen(index: Long) = if (index == lastIndex) lastLen else chunkSize

    private fun load(index: Long) {
        if (index == cachedIndex) return
        cachedIndex = -1
        val len = chunkLen(index)
        val pos = EncryptedFormat.HEADER_SIZE + index * record
        channel.readFully(ByteBuffer.wrap(ct, 0, len), pos)
        channel.readFully(ByteBuffer.wrap(tag), pos + len)
        if (!crypto.verify(index, index == lastIndex, ct, len, tag)) throw IOException("integrity")
        crypto.crypt(index, ct, len, plain)
        cachedIndex = index
    }
}
