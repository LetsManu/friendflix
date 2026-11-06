// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ShellIntentsTest {
    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()

    @Test fun theInternalEntryIsNotExportedAndOpensTheShell() {
        val info = context.packageManager.getActivityInfo(ComponentName(context.packageName, ShellIntents.INTERNAL), PackageManager.GET_META_DATA)
        assertFalse(info.exported)
        assertEquals(ShellActivity::class.java.name, info.targetActivity)
        // the launcher entry is the exported one
        assertTrue(context.packageManager.getActivityInfo(ComponentName(context, ShellActivity::class.java), 0).exported)
    }

    @Test fun onlyTheInternalEntryCountsAsTheAppsOwnHandOver() {
        assertTrue(ShellIntents.isInternal(ShellIntents.internal(context).putExtra(ShellActivity.EXTRA_OPEN_PATH, "/requests")))
        // another app can start the exported launcher entry with the same extras: they are ignored
        assertFalse(ShellIntents.isInternal(Intent(context, ShellActivity::class.java).putExtra(ShellActivity.EXTRA_WEB_WATCH, "/watch/x")))
        assertFalse(ShellIntents.isInternal(Intent(Intent.ACTION_MAIN)))
        assertFalse(ShellIntents.isInternal(null))
    }
}
