// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.setup

import android.content.Intent
import androidx.annotation.StringRes
import app.friendflix.android.setup.ProbeResult
import app.friendflix.android.shell.ServerAddress
import app.friendflix.android.shell.ServerAddressError
import app.friendflix.android.shell.origin
import app.friendflix.firetv.R
import okhttp3.HttpUrl

/** What the start screen shows first: a check of the stored server, or the address form. */
enum class TvSetupMode { CHECK, FORM }

/** The start screen's decisions, free of Android views (unit-tested). */
object TvSetupFlow {
    /** The https origin of what was typed (the shell's address rules). */
    fun validate(input: String): Result<HttpUrl> = ServerAddress.normalize(input)

    /** No stored server, or *Change server* from the web UI: the form; otherwise check the stored server and open it. */
    fun startMode(stored: HttpUrl?, change: Boolean): TvSetupMode = if (stored == null || change) TvSetupMode.FORM else TvSetupMode.CHECK

    /** The field's text: the address handed over (the current server on *Change server*), else the stored one, else empty. */
    fun prefill(stored: HttpUrl?, extra: String?): String = extra ?: stored?.origin() ?: ""

    @StringRes
    fun addressMessage(input: String, error: ServerAddressError): Int = when {
        input.isBlank() -> R.string.tv_error_empty
        error == ServerAddressError.INSECURE -> R.string.tv_error_insecure
        else -> R.string.tv_error_invalid
    }

    /** The failure line for a check, or null when the server is good. */
    @StringRes
    fun probeMessage(result: ProbeResult): Int? = when (result) {
        is ProbeResult.Ok -> null
        ProbeResult.NotFriendFlix -> R.string.tv_error_not_friendflix
        ProbeResult.TlsProblem -> R.string.tv_error_tls
        ProbeResult.AppTooOld -> R.string.tv_error_app_too_old
        ProbeResult.ServerTooOld -> R.string.tv_error_server_too_old
        ProbeResult.Unreachable -> R.string.tv_error_unreachable
    }

    /** The home screen's start of the app (MAIN with the launcher or leanback launcher category), not an in-app hand-over. */
    fun isLauncherIntent(action: String?, categories: Set<String>?): Boolean =
        action == Intent.ACTION_MAIN && categories.orEmpty().any { it == Intent.CATEGORY_LAUNCHER || it == Intent.CATEGORY_LEANBACK_LAUNCHER }
}
