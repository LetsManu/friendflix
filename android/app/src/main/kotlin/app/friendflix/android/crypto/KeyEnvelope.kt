// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import android.security.keystore.KeyPermanentlyInvalidatedException
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.SecureRandom
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The wrapping key that protects the stored data/MAC keys. Production: an Android Keystore AES-256-GCM key
 * ([AndroidKeystoreWrappingKeys]); tests use a plain JVM key.
 */
interface WrappingKeyStore {
    /**
     * The existing wrapping key, or null if it is *definitely* gone (no such alias, or the entry is unrecoverable). Throws
     * [KeysUnavailableException] for anything that may be transient (Keystore busy or erroring): the caller then keeps all state.
     */
    fun get(): SecretKey?

    /** Creates (replacing any existing one) and returns a new wrapping key. */
    fun create(): SecretKey

    /** Removes the wrapping key if present. Must not throw. */
    fun delete()
}

/**
 * The keys exist (or may exist) but cannot be used right now: Keystore error, I/O error reading the key blob, or new keys could not be
 * created/stored. Nothing was deleted. Callers treat it as "downloads unavailable, retry later" (never as lost keys).
 */
class KeysUnavailableException(message: String, cause: Throwable? = null) : IOException(message, cause)

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

    /**
     * The (dataKey, macKey) pair, or null if the keys are *definitely* lost: blob malformed or of another version, GCM tag mismatch
     * (tampered / wrapped under another key), or the wrapping key permanently invalidated. Any other failure (provider errors, a generic
     * InvalidKeyException, which the Keystore also uses for transient errors) throws [KeysUnavailableException].
     */
    @Suppress("TooGenericExceptionCaught")
    fun open(
        blob: ByteArray,
        wrappingKey: SecretKey,
        cipherFactory: () -> Cipher = { Cipher.getInstance(TRANSFORMATION) },
    ): Pair<ByteArray, ByteArray>? {
        if (blob.size != SIZE || blob[0] != VERSION) return null
        return try {
            val cipher = cipherFactory()
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_BITS, blob, 1, GCM_IV_BYTES))
            cipher.updateAAD(byteArrayOf(VERSION))
            cipher.updateAAD(AAD)
            val plain = cipher.doFinal(blob, 1 + GCM_IV_BYTES, blob.size - 1 - GCM_IV_BYTES)
            if (plain.size != 2 * KEY_BYTES) return null
            val pair = plain.copyOfRange(0, KEY_BYTES) to plain.copyOfRange(KEY_BYTES, 2 * KEY_BYTES)
            plain.fill(0)
            pair
        } catch (_: BadPaddingException) { // includes AEADBadTagException
            null
        } catch (_: KeyPermanentlyInvalidatedException) {
            null
        } catch (e: Exception) {
            throw KeysUnavailableException("cannot unwrap keys", e)
        }
    }
}

/**
 * Loads the data/MAC keys from [blobFile], wrapped under [wrapping].
 *
 * - blob present and unwraps → [KeyState.LOADED].
 * - no blob → fresh keys, [KeyState.CREATED] (a stale alias without its blob is replaced).
 * - definite loss → fresh keys, [KeyState.RESET]: alias missing or unrecoverable, blob malformed / other version, GCM tag mismatch,
 *   wrapping key permanently invalidated.
 * - anything possibly transient → [KeysUnavailableException], with blob and alias left untouched: Keystore errors, an I/O error
 *   reading the blob, or failing to create/store fresh keys.
 */
class EnvelopeKeys internal constructor(
    private val blobFile: File,
    private val wrapping: WrappingKeyStore,
    private val random: SecureRandom,
    private val unwrapCipher: () -> Cipher,
) {
    constructor(blobFile: File, wrapping: WrappingKeyStore) : this(blobFile, wrapping, SecureRandom(), DEFAULT_CIPHER)

    internal constructor(blobFile: File, wrapping: WrappingKeyStore, unwrapCipher: () -> Cipher) :
        this(blobFile, wrapping, SecureRandom(), unwrapCipher)

    fun load(): LoadedKeys {
        val blob = try {
            if (blobFile.exists()) blobFile.readBytes() else null
        } catch (e: IOException) {
            throw KeysUnavailableException("cannot read key blob", e)
        }
        if (blob == null) return fresh(KeyState.CREATED)
        val wrappingKey = wrapping.get() ?: return fresh(KeyState.RESET)
        val (data, mac) = KeyEnvelope.open(blob, wrappingKey, unwrapCipher) ?: return fresh(KeyState.RESET)
        return LoadedKeys(toKeys(data, mac), KeyState.LOADED)
    }

    @Suppress("TooGenericExceptionCaught")
    private fun fresh(state: KeyState): LoadedKeys {
        try {
            wrapping.delete()
            val wrappingKey = wrapping.create()
            val data = ByteArray(KeyEnvelope.KEY_BYTES).also { random.nextBytes(it) }
            val mac = ByteArray(KeyEnvelope.KEY_BYTES).also { random.nextBytes(it) }
            writeAtomically(KeyEnvelope.seal(data, mac, wrappingKey))
            return LoadedKeys(toKeys(data, mac), state)
        } catch (e: KeysUnavailableException) {
            throw e
        } catch (e: Exception) {
            throw KeysUnavailableException("cannot create keys", e)
        }
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

    private companion object {
        val DEFAULT_CIPHER: () -> Cipher = { Cipher.getInstance("AES/GCM/NoPadding") }
    }
}
