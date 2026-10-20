// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.annotation.StringRes
import app.friendflix.android.R

/**
 * The server's notification kinds (`notifications.kind`, backend `notify()` callers) grouped into the few categories the settings
 * toggle ([id] is what `AppSettings.notifyCategories` stores) and the Android channels ([channelId]) are made of.
 * A kind the table does not know (a newer server) lands in [OTHER].
 */
enum class NotifyCategory(val id: String, @StringRes val nameRes: Int, val kinds: Set<String>) {
    /** something to watch: new episodes of followed series, requested titles that arrived, reminders, finished download preparation */
    NEW("new", R.string.notify_cat_new, setOf("episode", "available", "available_all", "reminder", "download_ready")),

    /** the request service */
    REQUESTS("requests", R.string.notify_cat_requests, setOf("request_pending", "media_approved", "media_auto_approved", "media_declined")),

    /** the account itself and admin housekeeping: access window, device approvals, sign-up approvals, deletion */
    ACCOUNT(
        "account", R.string.notify_cat_account,
        setOf(
            "access_soon", "access_ended", "device_pending", "tv_paired", "approval", "account_deleted", "deletion_requested",
            "deletion_restored", "deletion_done", "deletion_failed", "playback_check",
        ),
    ),

    /** everything else: party and list invites, recommendations, polls, achievements ... */
    OTHER("other", R.string.notify_cat_other, emptySet());

    val channelId: String get() = "notify_$id"

    companion object {
        fun of(kind: String): NotifyCategory = entries.firstOrNull { kind in it.kinds } ?: OTHER

        /** All categories on: what the app does until the settings screen stored a choice. */
        val ALL_IDS: Set<String> = entries.map { it.id }.toSet()
    }
}

object Channels {
    /** One channel per category (names in the app's language; the user's own channel settings survive re-creation). */
    fun ensure(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        for (c in NotifyCategory.entries) {
            nm.createNotificationChannel(NotificationChannel(c.channelId, context.getString(c.nameRes), NotificationManager.IMPORTANCE_DEFAULT))
        }
    }
}
