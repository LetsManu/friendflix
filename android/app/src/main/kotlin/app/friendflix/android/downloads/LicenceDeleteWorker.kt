// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Gives a licence the user deleted in the app back to the server (`DELETE /api/downloads/:id`), so it no longer counts against the
 * quota. Best effort: a few tries with backoff; signed out → give up (the licence runs out on the server by itself).
 */
class LicenceDeleteWorker(context: Context, params: WorkerParameters, private val d: Downloads) : CoroutineWorker(context, params) {
    constructor(context: Context, params: WorkerParameters) : this(context, params, Downloads.get(context))

    override suspend fun doWork(): Result {
        val id = inputData.getString(KEY_ID) ?: return Result.failure()
        val profile = inputData.getString(KEY_PROFILE) ?: return Result.failure()
        val api = d.api() ?: return Result.failure()
        val ok = try {
            withContext(Dispatchers.IO) { api.deleteLicence(id, profile) }
        } catch (_: SessionExpired) {
            return Result.failure()
        } catch (_: IOException) {
            null
        }
        return when {
            ok == true -> Result.success()
            runAttemptCount < MAX_ATTEMPTS -> Result.retry()
            else -> Result.failure()
        }
    }

    companion object {
        private const val KEY_ID = "licenseId"
        private const val KEY_PROFILE = "profileId"
        private const val MAX_ATTEMPTS = 5
        /** every licence return carries this tag, plus its licence and profile as tags ([pending] reads them back) */
        const val TAG = "ff-licence-return"
        private const val TAG_ID = "ff-licence-return:id:"
        private const val TAG_PROFILE = "ff-licence-return:profile:"

        fun enqueue(wm: WorkManager, name: String, licenseId: String, profileId: String) {
            val req = OneTimeWorkRequestBuilder<LicenceDeleteWorker>()
                .setInputData(workDataOf(KEY_ID to licenseId, KEY_PROFILE to profileId))
                .addTag(TAG).addTag(TAG_ID + licenseId).addTag(TAG_PROFILE + profileId)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 60, TimeUnit.SECONDS)
                .build()
            wm.enqueueUniqueWork(name, ExistingWorkPolicy.KEEP, req)
        }

        /**
         * The licence returns still waiting to run (licenceId to profileId), read from their tags. A sign-out cancels all work and
         * gives these back itself while the session cookie still exists (a return left queued would only meet a 401 afterwards).
         */
        fun pending(wm: WorkManager): List<Pair<String, String>> = wm.getWorkInfosByTag(TAG).get().filter { !it.state.isFinished }.mapNotNull { info ->
            val id = info.tags.firstOrNull { it.startsWith(TAG_ID) }?.removePrefix(TAG_ID) ?: return@mapNotNull null
            val profile = info.tags.firstOrNull { it.startsWith(TAG_PROFILE) }?.removePrefix(TAG_PROFILE) ?: return@mapNotNull null
            id to profile
        }.distinctBy { it.first }
    }
}
