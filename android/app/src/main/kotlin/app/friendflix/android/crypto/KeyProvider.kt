// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.crypto

import javax.crypto.SecretKey

/**
 * The two keys of the download store: [key] (AES-256, encrypts the content with AES-CTR) and [macKey] (HMAC-SHA256, authenticates
 * every record). Production: [KeystoreKeyProvider]. Implementations must return the same keys for the life of the object.
 */
interface KeyProvider {
    fun key(): SecretKey
    fun macKey(): SecretKey
}
