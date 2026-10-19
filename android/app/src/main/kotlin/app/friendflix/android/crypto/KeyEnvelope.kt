// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The wrapping key that protects the stored data/MAC keys. Production: an Android Keystore AES-256-GCM key
 * ([AndroidKeystoreWrappingKeys]); tests use a plain JVM key.
 */
interface WrappingKeyStore {
    /** The existing wrapping key, or null if there is none (never created, or lost with the app data). Must not throw. */
    fun get(): SecretKey?

    /** Creates (replacing any existing one) and returns a new wrapping key. */
    fun create(): SecretKey

    /** Removes the wrapping key if present. Must not throw. */
    fun delete()
}

/** How [EnvelopeKeys.load] obtained its keys. */
enum class KeyState {
    /** The stored keys were unwrapped: existing downloads are readable. */
    LOADED,

    /** No stored keys existed (first use): any file already on disk was not written with these keys. */
    CREATED,

    /** Stored keys existed but could not be unwrapped (Keystore key gone, data restored/wiped, blob corrupt): old files are unreadable. */
    RESET,
}

/** Keys plus how they were obtained. When [oldFilesUnreadable], every existing encrypted download must be deleted (Task 7). */
class LoadedKeys(val keys: KeyProvider, val state: KeyState) {
    val oldFilesUnreadable: Boolean get() = state != KeyState.LOADED
}

private class FixedKeys(private val key: SecretKey, private val macKey: SecretKey) : KeyProvider {
    override fun key() = key
    override fun macKey() = macKey
}

/**
 * Blob format (version 1): `version u8 (=1) ‖ GCM IV (12 bytes) ‖ AES-GCM(wrappingKey, dataKey(32) ‖ macKey(32)) ‖ GCM tag (16)`,
 * with the version byte and the alias name as additional authenticated data. The IV is chosen by the cipher (the Keystore refuses
 * caller-supplied IVs for randomized encryption).
 */
internal object KeyEnvelope {
    const val VERSION: Byte = 1
    const val KEY_BYTES = 32
    private const val GCM_IV_BYTES = 12
    private const val GCM_TAG_BITS = 128
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private val AAD = "ff-dl-v1".toByteArray(Charsets.US_ASCII)
    private val SIZE = 1 + GCM_IV_BYTES + 2 * KEY_BYTES + GCM_TAG_BITS / 8

    fun seal(dataKey: ByteArray, macKey: ByteArray, wrappingKey: SecretKey): ByteArray {
        require(dataKey.size == KEY_BYTES && macKey.size == KEY_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)
        val iv = cipher.iv
        check(iv != null && iv.size == GCM_IV_BYTES) { "unexpected GCM IV" }
        cipher.updateAAD(byteArrayOf(VERSION))
        cipher.updateAAD(AAD)
        val plain = dataKey + macKey
        try {
            return byteArrayOf(VERSION) + iv + cipher.doFinal(plain)
        } finally {
            plain.fill(0)
        }
    }

    /** The (dataKey, macKey) pair, or null if the blob is malformed, of another version, tampered with or wrapped under another key. */
    @Suppress("TooGenericExceptionCaught") // Keystore failures surface as assorted runtime exceptions; any failure means "unreadable".
    fun open(blob: ByteArray, wrappingKey: SecretKey): Pair<ByteArray, ByteArray>? {
        if (blob.size != SIZE || blob[0] != VERSION) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_BITS, blob, 1, GCM_IV_BYTES))
            cipher.updateAAD(byteArrayOf(VERSION))
            cipher.updateAAD(AAD)
            val plain = cipher.doFinal(blob, 1 + GCM_IV_BYTES, blob.size - 1 - GCM_IV_BYTES)
            if (plain.size != 2 * KEY_BYTES) return null
            val pair = plain.copyOfRange(0, KEY_BYTES) to plain.copyOfRange(KEY_BYTES, 2 * KEY_BYTES)
            plain.fill(0)
            pair
        } catch (_: Exception) {
            null
        }
    }
}

/**
 * Loads the data/MAC keys from [blobFile], wrapped under [wrapping]. On first use, or when the stored keys cannot be unwrapped, it
 * generates fresh keys, stores them (atomically) and says so in [LoadedKeys.state]. It never throws for a lost or broken key; it throws
 * only if a new wrapping key cannot be created or the blob cannot be written (Keystore or storage unusable), which callers must treat
 * as "downloads unavailable".
 */
class EnvelopeKeys(
    private val blobFile: File,
    private val wrapping: WrappingKeyStore,
    private val random: SecureRandom = SecureRandom(),
) {
    fun load(): LoadedKeys {
        if (blobFile.exists()) {
            val blob = try { blobFile.readBytes() } catch (_: IOException) { null }
            val wrappingKey = wrapping.get()
            if (blob != null && wrappingKey != null) {
                KeyEnvelope.open(blob, wrappingKey)?.let { (data, mac) ->
                    val keys = toKeys(data, mac)
                    return LoadedKeys(keys, KeyState.LOADED)
                }
            }
            return fresh(KeyState.RESET)
        }
        return fresh(KeyState.CREATED)
    }

    private fun fresh(state: KeyState): LoadedKeys {
        wrapping.delete()
        val wrappingKey = wrapping.create()
        val data = ByteArray(KeyEnvelope.KEY_BYTES).also { random.nextBytes(it) }
        val mac = ByteArray(KeyEnvelope.KEY_BYTES).also { random.nextBytes(it) }
        writeAtomically(KeyEnvelope.seal(data, mac, wrappingKey))
        return LoadedKeys(toKeys(data, mac), state)
    }

    private fun toKeys(data: ByteArray, mac: ByteArray): KeyProvider {
        val keys = FixedKeys(SecretKeySpec(data, "AES"), SecretKeySpec(mac, "HmacSHA256"))
        data.fill(0)
        mac.fill(0)
        return keys
    }

    private fun writeAtomically(bytes: ByteArray) {
        blobFile.parentFile?.mkdirs()
        val tmp = File(blobFile.parentFile, blobFile.name + ".tmp")
        FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
        Files.move(tmp.toPath(), blobFile.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
}
