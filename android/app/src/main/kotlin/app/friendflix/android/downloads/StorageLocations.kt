// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.content.Context
import android.os.Environment
import android.os.storage.StorageManager
import app.friendflix.android.settings.StorageLocation
import java.io.File
import java.io.IOException

/** A place downloads can live. [freeBytes] is 0 when it is not [mounted]. */
data class Location(val kind: StorageLocation, val freeBytes: Long, val mounted: Boolean)

/** One app-specific volume root (`getExternalFilesDirs`); [root] is null while it is not mounted. */
data class Volume(val kind: StorageLocation, val root: File?, val mounted: Boolean)

fun interface VolumeSource {
    fun volumes(): List<Volume>
}

/**
 * Phone storage (index 0 of `getExternalFilesDirs`) and the first removable, mounted card. No storage permission is needed: both
 * are app-specific folders. Downloads live in their `downloads` subfolder. [move] changes the preferred place and moves what is there.
 */
class StorageLocations(
    private val source: VolumeSource,
    private val context: Context? = null,
    /** test hook for the free space of a folder; null = ask the system */
    private val freeSpace: ((File) -> Long)? = null,
    private val onMove: suspend (StorageLocation) -> Unit = {},
) {
    /** The phone always, the card when one exists (also while it is unmounted, then with mounted = false). */
    fun available(): List<Location> = source.volumes().map { v ->
        val root = v.root
        if (v.mounted && root != null) Location(v.kind, freeBytes(root), true) else Location(v.kind, 0, false)
    }

    fun isMounted(kind: StorageLocation): Boolean = source.volumes().any { it.kind == kind && it.mounted && it.root != null }

    /** The downloads folder of [kind] (created), or null while it is not mounted. Never falls back to another volume. */
    fun dirIfMounted(kind: StorageLocation): File? {
        val v = source.volumes().firstOrNull { it.kind == kind && it.mounted } ?: return null
        val dir = File(v.root ?: return null, DIR)
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) return null
        return dir
    }

    /** Bytes that can be written under [dir], counting cache the system would clear for us (falls back to the plain free space). */
    fun freeBytes(dir: File): Long {
        freeSpace?.let { return it(dir) }
        val sm = context?.getSystemService(StorageManager::class.java) ?: return dir.usableSpace
        return try { sm.getAllocatableBytes(sm.getUuidForPath(dir)) } catch (_: IOException) { dir.usableSpace }
    }

    /** Makes [to] the place for new downloads and moves finished ones there in the background (copy, verify, then delete the source). */
    suspend fun move(to: StorageLocation) = onMove(to)

    companion object {
        const val DIR = "downloads"

        /** The device's volumes. */
        fun system(context: Context): VolumeSource = VolumeSource {
            val app = context.applicationContext
            val dirs = app.getExternalFilesDirs(null)
            val phone = dirs.getOrNull(0)
            val phoneMounted = phone != null && Environment.getExternalStorageState(phone) == Environment.MEDIA_MOUNTED
            val card = dirs.drop(1).firstOrNull { d ->
                d != null && Environment.isExternalStorageRemovable(d) && Environment.getExternalStorageState(d) == Environment.MEDIA_MOUNTED
            }
            val cardKnown = card != null || (app.getSystemService(StorageManager::class.java)?.storageVolumes?.any { it.isRemovable } ?: false)
            listOfNotNull(
                Volume(StorageLocation.PHONE, phone?.takeIf { phoneMounted }, phoneMounted),
                when {
                    card != null -> Volume(StorageLocation.SD, card, true)
                    cardKnown -> Volume(StorageLocation.SD, null, false)
                    else -> null
                },
            )
        }
    }
}
