// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import java.security.SecureRandom
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/** In-memory keys for unit tests (Robolectric cannot reach AndroidKeyStore). Each instance has its own random keys. */
class TestKeys(
    private val key: SecretKey = SecretKeySpec(random(32), "AES"),
    private val macKey: SecretKey = SecretKeySpec(random(32), "HmacSHA256"),
) : KeyProvider {
    override fun key(): SecretKey = key
    override fun macKey(): SecretKey = macKey

    companion object {
        private val rnd = SecureRandom()
        fun random(n: Int): ByteArray = ByteArray(n).also { rnd.nextBytes(it) }
    }
}
