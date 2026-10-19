// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import java.io.File

/**
 * Proof that the offline licence rules passed. Sealed: no code outside this package (and module) can subclass it, and the only
 * instance is private to [Offline] — so nothing but [Offline.prepare] can build an [OfflineMedia].
 */
sealed class OfflineVerdict

/**
 * A downloaded title as the player gets it (offline gate → player). All files are FFE1-encrypted (read them with
 * `EncryptedDataSource` and the download keys); [licenseId] is what the player reports positions under (`Offline.recordPosition`).
 *
 * Unforgeable on purpose: the constructor needs an [OfflineVerdict], which only [Offline.prepare] holds, so a request that carries
 * an OfflineMedia has been through the verdict (licence, offline window, clock, keys, storage, file). It is not a data class (no
 * public `copy`). The player keeps only [licenseId] across a restore and asks [Offline.prepare] again for a fresh one.
 */
class OfflineMedia internal constructor(
    val licenseId: String,
    val video: File,
    /** text subtitles next to the video: language and encrypted `.vtt` / `.srt` file */
    val subtitles: List<Pair<String, File>>,
    @Suppress("unused") verdict: OfflineVerdict,
)
