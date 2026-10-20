// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import android.security.keystore.KeyPermanentlyInvalidatedException
import java.io.File
import java.security.AlgorithmParameters
import java.security.InvalidKeyException
import java.security.Key
import java.security.ProviderException
import java.security.SecureRandom
import java.security.Security
import java.security.spec.AlgorithmParameterSpec
import javax.crypto.Cipher
import javax.crypto.CipherSpi
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The Keystore-independent part of KeystoreKeyProvider: a JVM AES key stands in for the Keystore wrapping key. Robolectric only so that
 * android.security.keystore.KeyPermanentlyInvalidatedException can be constructed.
 */
@RunWith(RobolectricTestRunner::class)
class EnvelopeKeysTest {
    @get:Rule val tmp = TemporaryFolder()

    private class FakeWrappingKeys : WrappingKeyStore {
        var key: SecretKey? = null
        var creates = 0
        var transient = false
        override fun get(): SecretKey? {
            if (transient) throw KeysUnavailableException("keystore busy")
            return key
        }
        override fun create(): SecretKey = SecretKeySpec(TestKeys.random(32), "AES").also { key = it; creates++ }
        override fun delete() { key = null }
    }

    /** A Cipher whose init throws [failure], standing in for Keystore errors. */
    private class FailingSpi(private val failure: Exception) : CipherSpi() {
        override fun engineInit(opmode: Int, key: Key?, random: SecureRandom?) = throw failure
        override fun engineInit(opmode: Int, key: Key?, params: AlgorithmParameterSpec?, random: SecureRandom?) = throw failure
        override fun engineInit(opmode: Int, key: Key?, params: AlgorithmParameters?, random: SecureRandom?) = throw failure
        override fun engineSetMode(mode: String?) = Unit
        override fun engineSetPadding(padding: String?) = Unit
        override fun engineGetBlockSize() = 16
        override fun engineGetOutputSize(inputLen: Int) = inputLen
        override fun engineGetIV(): ByteArray? = null
        override fun engineGetParameters(): AlgorithmParameters? = null
        override fun engineUpdate(input: ByteArray?, inputOffset: Int, inputLen: Int): ByteArray = error("unused")
        override fun engineUpdate(input: ByteArray?, inputOffset: Int, inputLen: Int, output: ByteArray?, outputOffset: Int): Int = error("unused")
        override fun engineDoFinal(input: ByteArray?, inputOffset: Int, inputLen: Int): ByteArray = error("unused")
        override fun engineDoFinal(input: ByteArray?, inputOffset: Int, inputLen: Int, output: ByteArray?, outputOffset: Int): Int = error("unused")
    }

    private class FailingCipher(failure: Exception) : Cipher(FailingSpi(failure), Security.getProviders()[0], "AES/GCM/NoPadding")

    private fun blob() = File(tmp.root, "keys.bin")

    @Test fun sealAndOpen() {
        val wrap = SecretKeySpec(TestKeys.random(32), "AES")
        val dataKey = TestKeys.random(32)
        val macKey = TestKeys.random(32)
        val sealed = KeyEnvelope.seal(dataKey, macKey, wrap)
        assertEquals(1, sealed[0].toInt())
        assertEquals(1 + 12 + 64 + 16, sealed.size)
        val opened = KeyEnvelope.open(sealed, wrap)
        assertNotNull(opened)
        assertArrayEquals(dataKey, opened!!.first)
        assertArrayEquals(macKey, opened.second)
        // Fresh GCM IV each time.
        assertFalse(sealed.contentEquals(KeyEnvelope.seal(dataKey, macKey, wrap)))
    }

    @Test fun openRejectsWrongKeyTamperingAndJunk() {
        val wrap = SecretKeySpec(TestKeys.random(32), "AES")
        val sealed = KeyEnvelope.seal(TestKeys.random(32), TestKeys.random(32), wrap)
        assertNull(KeyEnvelope.open(sealed, SecretKeySpec(TestKeys.random(32), "AES")))
        for (i in sealed.indices) {
            val t = sealed.copyOf().also { it[i] = (it[i].toInt() xor 1).toByte() }
            assertNull("byte $i", KeyEnvelope.open(t, wrap))
        }
        assertNull(KeyEnvelope.open(sealed.copyOf(sealed.size - 1), wrap))
        assertNull(KeyEnvelope.open(ByteArray(0), wrap))
    }

    @Test fun firstUseCreatesThenLoadsTheSameKeys() {
        val store = FakeWrappingKeys()
        val first = EnvelopeKeys(blob(), store).load()
        assertEquals(KeyState.CREATED, first.state)
        assertTrue(blob().exists())
        val second = EnvelopeKeys(blob(), store).load()
        assertEquals(KeyState.LOADED, second.state)
        assertArrayEquals(first.keys.key().encoded, second.keys.key().encoded)
        assertArrayEquals(first.keys.macKey().encoded, second.keys.macKey().encoded)
        assertEquals(1, store.creates)
        assertEquals("AES", second.keys.key().algorithm)
        assertEquals("HmacSHA256", second.keys.macKey().algorithm)
        assertFalse(first.keys.key().encoded.contentEquals(first.keys.macKey().encoded))
    }

    @Test fun lostWrappingKeyResetsWithFreshKeys() {
        val store = FakeWrappingKeys()
        val first = EnvelopeKeys(blob(), store).load()
        store.key = null // app data restored / Keystore wiped
        val reset = EnvelopeKeys(blob(), store).load()
        assertEquals(KeyState.RESET, reset.state)
        assertTrue(reset.oldFilesUnreadable)
        assertFalse(first.keys.key().encoded.contentEquals(reset.keys.key().encoded))
        val again = EnvelopeKeys(blob(), store).load()
        assertEquals(KeyState.LOADED, again.state)
        assertFalse(again.oldFilesUnreadable)
        assertArrayEquals(reset.keys.key().encoded, again.keys.key().encoded)
    }

    @Test fun unwrapFailureResets() {
        val store = FakeWrappingKeys()
        EnvelopeKeys(blob(), store).load()
        store.create() // a different wrapping key under the alias: GCM tag fails
        assertEquals(KeyState.RESET, EnvelopeKeys(blob(), store).load().state)

        blob().writeBytes(byteArrayOf(9, 9, 9)) // corrupt / unknown version
        assertEquals(KeyState.RESET, EnvelopeKeys(blob(), store).load().state)
        assertEquals(KeyState.LOADED, EnvelopeKeys(blob(), store).load().state)
    }

    @Test fun permanentlyInvalidatedKeyResets() {
        val store = FakeWrappingKeys()
        val first = EnvelopeKeys(blob(), store).load()
        val reset = EnvelopeKeys(blob(), store, unwrapCipher = { FailingCipher(KeyPermanentlyInvalidatedException()) }).load()
        assertEquals(KeyState.RESET, reset.state)
        assertFalse(first.keys.key().encoded.contentEquals(reset.keys.key().encoded))
        assertEquals(2, store.creates)
        assertEquals(KeyState.LOADED, EnvelopeKeys(blob(), store).load().state)
    }

    @Test fun missingBlobWithStaleAliasCreatesFresh() {
        val store = FakeWrappingKeys()
        store.create()
        val loaded = EnvelopeKeys(blob(), store).load()
        assertEquals(KeyState.CREATED, loaded.state)
        assertTrue(loaded.oldFilesUnreadable)
        assertEquals(KeyState.LOADED, EnvelopeKeys(blob(), store).load().state)
    }

    private fun assertTransient(store: FakeWrappingKeys, keys: EnvelopeKeys, before: LoadedKeys) {
        val blobBefore = blob().takeIf { it.isFile }?.readBytes()
        val keyBefore = store.key
        assertThrows(KeysUnavailableException::class.java) { keys.load() }
        assertSame("wrapping key kept", keyBefore, store.key)
        if (blobBefore != null) assertArrayEquals("blob kept", blobBefore, blob().readBytes())
        store.transient = false
        val after = EnvelopeKeys(blob(), store).load()
        assertEquals(KeyState.LOADED, after.state)
        assertFalse(after.oldFilesUnreadable)
        assertArrayEquals(before.keys.key().encoded, after.keys.key().encoded)
    }

    @Test fun transientKeystoreLookupKeepsKeys() {
        val store = FakeWrappingKeys()
        val before = EnvelopeKeys(blob(), store).load()
        store.transient = true
        assertTransient(store, EnvelopeKeys(blob(), store), before)
    }

    @Test fun transientUnwrapFailureKeepsKeys() {
        val store = FakeWrappingKeys()
        val before = EnvelopeKeys(blob(), store).load()
        for (failure in listOf(ProviderException("busy"), InvalidKeyException("Keystore operation failed"), IllegalStateException("x"))) {
            assertTransient(store, EnvelopeKeys(blob(), store, unwrapCipher = { FailingCipher(failure) }), before)
        }
    }

    @Test fun unreadableBlobKeepsKeys() {
        val store = FakeWrappingKeys()
        val before = EnvelopeKeys(blob(), store).load()
        val saved = blob().readBytes()
        blob().delete()
        blob().mkdir() // exists, but reading it fails with an IOException
        assertThrows(KeysUnavailableException::class.java) { EnvelopeKeys(blob(), store).load() }
        assertEquals(1, store.creates)
        assertNotNull(store.key)
        blob().delete()
        blob().writeBytes(saved)
        val after = EnvelopeKeys(blob(), store).load()
        assertEquals(KeyState.LOADED, after.state)
        assertArrayEquals(before.keys.key().encoded, after.keys.key().encoded)
    }

    @Test fun keysWorkWithTheFileFormat() {
        val keys = EnvelopeKeys(blob(), FakeWrappingKeys()).load().keys
        val f = File(tmp.root, "x")
        EncryptedWriter(f, keys).use { it.append(byteArrayOf(1, 2, 3)); it.finish() }
        EncryptedReader(f, keys).use { r -> ByteArray(3).also { assertEquals(3, r.read(0, it, 0, 3)) } }
    }
}
