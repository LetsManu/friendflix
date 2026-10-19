// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.annotation.RequiresApi
import java.io.File
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Production [KeyProvider]: an envelope. The Android Keystore key [ALIAS] (AES-256-GCM, StrongBox when available) wraps a random
 * 32-byte data key and a random 32-byte MAC key, stored in `noBackupFilesDir` (never cloud-backed). The unwrapped keys live in process
 * memory; javax.crypto does the per-chunk work (Keystore calls per 1 MiB chunk would be far too slow for multi-GB files).
 *
 * Use [open] once per process, off the main thread. If [oldFilesUnreadable], existing downloads were written with keys that are gone
 * and must be deleted (Task 7). Instrumented coverage: androidTest `KeystoreKeyProviderTest`; the blob logic is unit-tested in
 * `EnvelopeKeysTest` with a JVM wrapping key.
 */
class KeystoreKeyProvider private constructor(loaded: LoadedKeys) : KeyProvider {
    private val keys = loaded.keys
    val state: KeyState = loaded.state
    val oldFilesUnreadable: Boolean = loaded.oldFilesUnreadable

    override fun key(): SecretKey = keys.key()
    override fun macKey(): SecretKey = keys.macKey()

    companion object {
        const val ALIAS = "ff-dl-v1"
        private const val BLOB_NAME = "ff-dl-v1.keys"

        /**
         * Loads or creates the keys. Blocking (Keystore, disk). Throws only if the Keystore cannot create a key or the blob cannot
         * be written; a lost or unusable stored key is not an error but [KeyState.RESET].
         */
        @Synchronized
        fun open(context: Context): KeystoreKeyProvider =
            KeystoreKeyProvider(EnvelopeKeys(File(context.noBackupFilesDir, BLOB_NAME), AndroidKeystoreWrappingKeys(ALIAS)).load())
    }
}

/** The wrapping key in the Android Keystore: AES-256-GCM, encrypt|decrypt, no user authentication, StrongBox if the device has it. */
internal class AndroidKeystoreWrappingKeys(private val alias: String) : WrappingKeyStore {
    private val keyStore: KeyStore by lazy { KeyStore.getInstance(PROVIDER).apply { load(null) } }

    @Suppress("TooGenericExceptionCaught") // a broken entry can fail in many ways; all mean "no usable key"
    override fun get(): SecretKey? = try {
        keyStore.getKey(alias, null) as? SecretKey
    } catch (_: Exception) {
        null
    }

    override fun create(): SecretKey {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return generate(strongBox = true)
            } catch (_: StrongBoxUnavailableException) {
                // fall through: TEE-backed key
            }
        }
        return generate(strongBox = false)
    }

    @Suppress("TooGenericExceptionCaught")
    override fun delete() {
        try {
            keyStore.deleteEntry(alias)
        } catch (_: Exception) {
            // nothing to delete, or the Keystore is unusable (create() will then report it)
        }
    }

    private fun generate(strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setStrongBox(spec)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(spec.build())
        return generator.generateKey()
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private fun setStrongBox(spec: KeyGenParameterSpec.Builder) {
        spec.setIsStrongBoxBacked(true)
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
    }
}
