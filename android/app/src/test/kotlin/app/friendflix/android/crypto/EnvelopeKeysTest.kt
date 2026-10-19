// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import java.io.File
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The Keystore-independent part of KeystoreKeyProvider: a JVM AES key stands in for the Keystore wrapping key. */
class EnvelopeKeysTest {
    @get:Rule val tmp = TemporaryFolder()

    private class FakeWrappingKeys : WrappingKeyStore {
        var key: SecretKey? = null
        var creates = 0
        override fun get(): SecretKey? = key
        override fun create(): SecretKey = SecretKeySpec(TestKeys.random(32), "AES").also { key = it; creates++ }
        override fun delete() { key = null }
    }

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
        store.create() // a different wrapping key under the alias
        assertEquals(KeyState.RESET, EnvelopeKeys(blob(), store).load().state)

        blob().writeBytes(byteArrayOf(9, 9, 9)) // corrupt / unknown version
        assertEquals(KeyState.RESET, EnvelopeKeys(blob(), store).load().state)
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

    @Test fun keysWorkWithTheFileFormat() {
        val keys = EnvelopeKeys(blob(), FakeWrappingKeys()).load().keys
        val f = File(tmp.root, "x")
        EncryptedWriter(f, keys).use { it.append(byteArrayOf(1, 2, 3)); it.finish() }
        EncryptedReader(f, keys).use { r -> ByteArray(3).also { assertEquals(3, r.read(0, it, 0, 3)) } }
    }
}
