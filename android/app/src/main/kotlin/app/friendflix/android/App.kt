// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android

import android.app.Application
import android.util.Log
import androidx.work.Configuration
import app.friendflix.android.downloads.DownloadQueue

/**
 * Process-wide entry point. WorkManager is initialised on demand from here (the default startup initializer is removed in the
 * manifest), and the download queue listens for storage cards coming and going.
 */
class App : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setMinimumLoggingLevel(if (BuildConfig.DEBUG) Log.INFO else Log.ERROR).build()

    override fun onCreate() {
        super.onCreate()
        DownloadQueue.watchVolumes(this)
    }
}
