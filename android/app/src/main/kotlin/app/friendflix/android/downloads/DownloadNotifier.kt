// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.ForegroundInfo
import app.friendflix.android.R
import app.friendflix.android.shell.ShellActivity

/** The download notifications: the foreground progress (dataSync) and the one "sign in again" notice. */
interface DownloadNotifier {
    fun foreground(licenseId: String, percent: Int): ForegroundInfo
    fun sessionExpired()
    fun clearSessionExpired()
}

/**
 * System notifications. Texts never contain titles (they show on the lock screen). Without the notification permission (Task 11 asks
 * for it) posting is skipped; the foreground service still runs, Android just hides its notification.
 */
class SystemDownloadNotifier(context: Context) : DownloadNotifier {
    private val app = context.applicationContext

    init { ensureChannels() }

    private fun ensureChannels() {
        val nm = app.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(NotificationChannel(CH_PROGRESS, app.getString(R.string.dl_channel_progress), NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_ALERTS, app.getString(R.string.dl_channel_alerts), NotificationManager.IMPORTANCE_DEFAULT))
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        app, 0, Intent(app, ShellActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    override fun foreground(licenseId: String, percent: Int): ForegroundInfo {
        val p = percent.coerceIn(0, 100)
        val n = NotificationCompat.Builder(app, CH_PROGRESS)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(app.getString(R.string.dl_progress_title))
            .setContentText(app.getString(R.string.dl_progress_percent, p))
            .setProgress(100, p, false)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setContentIntent(openApp())
            .build()
        val id = ID_PROGRESS_BASE + (licenseId.hashCode() and 0xFFFF)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(id, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(id, n)
    }

    override fun sessionExpired() {
        if (!canPost()) return
        val n = NotificationCompat.Builder(app, CH_ALERTS)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(app.getString(R.string.dl_signin_title))
            .setContentText(app.getString(R.string.dl_signin_text))
            .setStyle(NotificationCompat.BigTextStyle().bigText(app.getString(R.string.dl_signin_text)))
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build()
        try {
            NotificationManagerCompat.from(app).notify(ID_SIGN_IN, n)
        } catch (_: SecurityException) {
            // permission withdrawn in between: nothing to show
        }
    }

    override fun clearSessionExpired() = NotificationManagerCompat.from(app).cancel(ID_SIGN_IN)

    private fun canPost(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(app).areNotificationsEnabled()
    }

    companion object {
        const val CH_PROGRESS = "downloads"
        const val CH_ALERTS = "download_alerts"
        const val ID_SIGN_IN = 7001
        private const val ID_PROGRESS_BASE = 0x10000
    }
}
