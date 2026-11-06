// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.io.IOException
import java.security.KeyStore
import java.util.Random
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Real AndroidKeyStore (emulator job): create, reload and lose the wrapping key; round-trip a small encrypted file. */
@RunWith(AndroidJUnit4::class)
class KeystoreKeyProviderTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val blob = File(context.noBackupFilesDir, "ff-dl-v1.keys")
    private val file = File(context.cacheDir, "keystore-test.ffe")

    private fun deleteAlias() = KeyStore.getInstance("AndroidKeyStore").run { load(null); deleteEntry(KeystoreKeyProvider.ALIAS) }

    @Before @After fun clean() {
        blob.delete()
        file.delete()
        deleteAlias()
    }

    private fun roundTrip(keys: KeyProvider, data: ByteArray) = EncryptedReader(file, keys).use { r ->
        assertEquals(data.size.toLong(), r.length)
        ByteArray(data.size).also { assertEquals(data.size, r.read(0, it, 0, it.size)) }
    }

    @Test fun createLoadAndLoseKeys() {
        val data = ByteArray(EncryptedFormat.CHUNK_SIZE + 4096).also { Random(1).nextBytes(it) }

        val first = KeystoreKeyProvider.open(context)
        assertEquals(KeyState.CREATED, first.state)
        EncryptedWriter(file, first).use { it.append(data); it.finish() }
        assertArrayEquals(data, roundTrip(first, data))

        val second = KeystoreKeyProvider.open(context)
        assertEquals(KeyState.LOADED, second.state)
        assertFalse(second.oldFilesUnreadable)
        assertArrayEquals(data, roundTrip(second, data))

        deleteAlias() // as after a data restore to another device
        val third = KeystoreKeyProvider.open(context)
        assertEquals(KeyState.RESET, third.state)
        assertTrue(third.oldFilesUnreadable)
        try {
            EncryptedReader(file, third).close()
            fail("old file must be unreadable with the new keys")
        } catch (e: IOException) {
            assertEquals("integrity", e.message)
        }
        assertEquals(KeyState.LOADED, KeystoreKeyProvider.open(context).state)
    }
}
