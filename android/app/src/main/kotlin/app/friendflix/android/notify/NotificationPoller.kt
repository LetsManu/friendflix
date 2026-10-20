// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.friendflix.android.downloads.Downloads
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.SessionExpired
import app.friendflix.android.settings.AppSettings
import app.friendflix.android.shell.ShellActivity
import app.friendflix.android.shell.ShellIntents
import kotlinx.coroutines.flow.first
import okhttp3.HttpUrl
import org.json.JSONObject
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException
import java.util.concurrent.TimeUnit

/** One server notification, as much of it as the poller uses. */
data class ServerNote(val id: Long, val kind: String, val title: String, val body: String?, val link: String?, val read: Boolean)

/** Shows a notification on the device. */
interface NotePoster {
    /** false while POST_NOTIFICATIONS is missing or notifications are switched off for the app */
    fun canPost(): Boolean

    /** [path] is already validated ([NotifyLinks.safePath]) or null (open the app). Texts are the server's. */
    fun post(note: ServerNote, category: NotifyCategory, path: String?)
}

/**
 * Turns `GET /api/notifications` into Android notifications (spec §8: polling, no push service). One [poll] never throws for network
 * trouble and never asks twice: the next period tries again.
 *
 * - First run for a server only records the newest id (no flood of old items).
 * - New = id greater than the last seen id; items already read on the web, and items of a category the user switched off, are
 *   consumed silently (enabling a category later does not replay them).
 * - Without the notification permission nothing is consumed: the items are still new when the permission is granted (Task 11 asks).
 * - 401 (also `/api/me`) stops polling until the next app open ([AppSettings.notifyPaused]). 403 (kids profile), 409, 5xx, offline,
 *   odd answers: nothing happens until the next period.
 * - Does not mark anything read on the server: the web marks read when the bell or the account page *shows* them; a status-bar
 *   notification is not that, and marking would clear the web badge for items the person never read.
 * - Titles and bodies are never logged.
 */
class NotificationPoller(
    private val settings: AppSettings,
    private val api: suspend () -> ServerApi?,
    private val poster: NotePoster,
) {
    suspend fun poll() {
        val origin = settings.serverOrigin.first() ?: return
        if (settings.notifyPaused.first()) return
        val key = originKey(origin)
        val last = settings.notifyLastId(key).first()
        if (last != null && !poster.canPost()) return // nothing to show, nothing consumed
        val notes = try {
            fetch(api() ?: return)
        } catch (_: SessionExpired) {
            settings.setNotifyPaused(true)
            return
        } catch (_: IOException) {
            return
        } ?: return
        if (last == null) { // first run for this server: remember where we are
            settings.setNotifyLastId(key, notes.maxOfOrNull { it.id } ?: 0)
            return
        }
        val fresh = notes.filter { it.id > last }.sortedBy { it.id }
        if (fresh.isEmpty()) return
        if (!poster.canPost()) return
        val enabled = settings.notifyCategoriesChosen.first() ?: NotifyCategory.ALL_IDS
        var done = last
        for (n in fresh) {
            val cat = NotifyCategory.of(n.kind)
            if (!n.read && cat.id in enabled) {
                try {
                    poster.post(n, cat, NotifyLinks.safePath(origin, n.link))
                } catch (_: SecurityException) {
                    break // permission withdrawn meanwhile: keep this one and the rest for later
                }
            }
            done = n.id
        }
        if (done != last) settings.setNotifyLastId(key, done)
    }

    private fun fetch(api: ServerApi): List<ServerNote>? {
        val me = api.me() ?: return null
        val (code, body) = api.getJson("/api/notifications", me.profileId ?: "")
        if (code != 200 || body == null) return null
        return parse(body)
    }

    private fun parse(body: JSONObject): List<ServerNote>? {
        val a = body.optJSONArray("notifications") ?: return null
        return (0 until a.length()).mapNotNull { i ->
            val o = a.optJSONObject(i) ?: return@mapNotNull null
            // node-pg hands a bigserial out as a string ("123"); a number is fine too
            val id = when (val v = o.opt("id")) {
                is Number -> v.toLong()
                is String -> v.toLongOrNull()
                else -> null
            }?.takeIf { it >= 0 } ?: return@mapNotNull null
            ServerNote(
                id, o.optString("kind"), o.optString("title"),
                if (o.isNull("body")) null else o.optString("body").takeIf { it.isNotEmpty() },
                if (o.isNull("link")) null else o.optString("link").takeIf { it.isNotEmpty() },
                o.optBoolean("read", false),
            )
        }
    }

    companion object {
        fun originKey(origin: HttpUrl) = "${origin.scheme}://${origin.host}:${origin.port}"
    }
}

/** The system notification: one channel per category, tap opens the shell on the (validated) path. */
class SystemNotePoster(context: Context) : NotePoster {
    private val app = context.applicationContext

    init { Channels.ensure(app) }

    override fun canPost(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(app).areNotificationsEnabled()
    }

    // The poller checks canPost() first and treats a SecurityException (permission withdrawn in between) as "keep for later".
    @SuppressLint("MissingPermission")
    override fun post(note: ServerNote, category: NotifyCategory, path: String?) {
        val id = notificationId(note.id)
        val open = ShellIntents.internal(app)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (path != null) open.putExtra(ShellActivity.EXTRA_OPEN_PATH, path)
        val b = NotificationCompat.Builder(app, category.channelId)
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle(note.title)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(app, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        note.body?.let { b.setContentText(it).setStyle(NotificationCompat.BigTextStyle().bigText(it)) }
        NotificationManagerCompat.from(app).notify(id, b.build())
    }

    companion object {
        private const val BASE = 0x20000000
        fun notificationId(serverId: Long): Int = BASE + (serverId and 0x0FFFFFFF).toInt()
    }
}

/** The periodic job (15 min, the WorkManager minimum, with flex; online only). Failures never retry: the next period is the retry. */
class NotificationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val d = Downloads.get(applicationContext)
        try {
            NotificationPoller(d.settings, { d.api() }, SystemNotePoster(applicationContext)).poll()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // never a retry storm, whatever went wrong; the next period asks again (no details: they could hold titles)
        }
        return Result.success()
    }
}

object NotificationScheduler {
    const val WORK_NAME = "notify-poll"
    const val PERIOD_MIN = 15L
    const val FLEX_MIN = 5L

    /** Enqueues the periodic poll once (KEEP: an existing schedule is left alone). Safe to call at every start. */
    fun schedule(context: Context, wm: WorkManager = WorkManager.getInstance(context)) {
        val req = PeriodicWorkRequestBuilder<NotificationWorker>(PERIOD_MIN, TimeUnit.MINUTES, FLEX_MIN, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        wm.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** The app was opened (the person may have signed in again): polling resumes and the schedule is ensured. */
    suspend fun rearm(context: Context) {
        Downloads.get(context).settings.setNotifyPaused(false)
        schedule(context)
    }
}
