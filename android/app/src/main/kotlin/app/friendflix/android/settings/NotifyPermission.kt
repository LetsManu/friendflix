// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.settings

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResultLauncher
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.first

/**
 * The notification permission (Android 13+ asks for POST_NOTIFICATIONS at runtime). The app asks on its own exactly once
 * ([askOnce], first start with a server); after that only the settings screen asks, and only when the person taps it.
 */
object NotifyPermission {
    /** Android 13+ and the permission is not granted yet. */
    fun missing(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    /** The app may post notifications (permission and the app-wide system switch). */
    fun enabled(context: Context): Boolean = !missing(context) && NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** Launches the system dialog (Android 13+ only; a no-op below, where there is no runtime permission). */
    fun request(launcher: ActivityResultLauncher<String>) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** First start with a server: ask once, never again on its own (also when the person said no). */
    suspend fun askOnce(context: Context, settings: AppSettings, launcher: ActivityResultLauncher<String>) {
        if (!missing(context) || settings.notifyPermissionAsked.first()) return
        settings.setNotifyPermissionAsked()
        request(launcher)
    }

    /** The system's notification settings of this app (when the dialog can no longer be shown, or notifications are switched off there). */
    fun systemSettings(context: Context): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
}
