// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.settings

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.text.format.Formatter
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.VisibleForTesting
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import app.friendflix.android.BuildConfig
import app.friendflix.android.R
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.downloads.Downloads
import app.friendflix.android.notify.NotifyCategory
import app.friendflix.android.offline.Offline
import app.friendflix.android.offline.OfflineActivity
import app.friendflix.android.setup.SetupActivity
import app.friendflix.android.shell.ServerAddress
import app.friendflix.android.shell.ShellActivity
import app.friendflix.android.shell.origin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl

/**
 * The app's own settings (plain views, like setup and the offline list), opened from the web UI through the bridge's
 * `openSettings()`, from the offline list and from the system's app info screen. Everything else is set in the web UI.
 *
 * - Server address: change after a confirmation that says downloads are removed; [DeviceReset.leaveServer], then setup probes the
 *   new address.
 * - Downloads: phone or SD card with free space (a change offers to move finished downloads, [StorageLocations.move]), Wi-Fi only.
 * - Background audio for the player.
 * - Notifications: the permission (asked only when tapped here) and the four categories (ids of [NotifyCategory]).
 * - "Sign out of this device": [DeviceReset.signOut] after a confirmation.
 */
class SettingsActivity : ComponentActivity() {
    private lateinit var downloads: Downloads
    private lateinit var settings: AppSettings
    private lateinit var progress: ProgressBar
    private lateinit var storage: RadioGroup
    private lateinit var notifyStatus: TextView
    private lateinit var notifyAllow: Button
    private var origin: HttpUrl? = null
    private var busy = false
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { renderNotify() }

    /** what the screen calls for a reset (tests put their own in) */
    @VisibleForTesting
    internal var reset: () -> DeviceReset = { DeviceReset(applicationContext, Offline.get(applicationContext)) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        downloads = Downloads.get(applicationContext)
        settings = downloads.settings
        setContentView(R.layout.activity_settings)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.settings_root)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        listOf(R.id.settings_heading, R.id.settings_server_heading, R.id.settings_storage_heading, R.id.settings_playback_heading,
            R.id.settings_notify_heading, R.id.settings_device_heading).forEach { ViewCompat.setAccessibilityHeading(findViewById(it), true) }
        progress = findViewById(R.id.settings_progress)
        storage = findViewById(R.id.settings_storage)
        notifyStatus = findViewById(R.id.settings_notify_status)
        notifyAllow = findViewById(R.id.settings_notify_allow)
        findViewById<TextView>(R.id.settings_version).text = getString(R.string.settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)
        findViewById<Button>(R.id.settings_server_change).setOnClickListener { askServer() }
        findViewById<Button>(R.id.settings_sign_out).setOnClickListener { confirmSignOut() }
        findViewById<Button>(R.id.settings_offline).setOnClickListener { startActivity(OfflineActivity.intent(this)) }
        notifyAllow.setOnClickListener { allowNotifications() }
        lifecycleScope.launch { bind() }
    }

    override fun onResume() {
        super.onResume()
        renderNotify() // back from the system's notification settings
        lifecycleScope.launch { renderStorage() } // a card may have come or gone
    }

    private suspend fun bind() {
        origin = settings.serverOrigin.first()
        findViewById<TextView>(R.id.settings_server_value).text = origin?.let(::display) ?: ""
        bindCheck(R.id.settings_wifi_only, settings.wifiOnly.first()) {
            settings.setWifiOnly(it)
            downloads.queue.rescheduleAll() // waiting jobs get the new network constraint; a running transfer resumes by Range
        }
        bindCheck(R.id.settings_background_audio, settings.backgroundAudio.first()) { settings.setBackgroundAudio(it) }
        val chosen = settings.notifyCategoriesChosen.first() ?: NotifyCategory.ALL_IDS
        val box = findViewById<LinearLayout>(R.id.settings_notify_categories)
        box.removeAllViews()
        for (c in NotifyCategory.entries) {
            val cb = CheckBox(this).apply {
                text = getString(c.nameRes)
                tag = c.id
                minHeight = (48 * resources.displayMetrics.density).toInt()
                isChecked = c.id in chosen
            }
            cb.setOnCheckedChangeListener { _, _ ->
                val ids = (0 until box.childCount).map { box.getChildAt(it) as CheckBox }.filter { it.isChecked }.map { it.tag as String }.toSet()
                lifecycleScope.launch { settings.setNotifyCategories(ids) }
            }
            box.addView(cb)
        }
        renderStorage()
        renderNotify()
    }

    private fun bindCheck(id: Int, value: Boolean, save: suspend (Boolean) -> Unit) {
        val cb = findViewById<CheckBox>(id)
        cb.isChecked = value
        cb.setOnCheckedChangeListener { _, on -> lifecycleScope.launch { save(on) } }
    }

    // ---- storage ----

    private suspend fun renderStorage() {
        val (places, current) = withContext(Dispatchers.IO) { downloads.locations.available() to settings.storage.first() }
        storage.setOnCheckedChangeListener(null)
        storage.removeAllViews()
        for (loc in places) {
            val rb = RadioButton(this).apply {
                id = View.generateViewId()
                tag = loc.kind
                minHeight = (48 * resources.displayMetrics.density).toInt()
                text = when {
                    loc.kind == StorageLocation.PHONE -> getString(R.string.settings_storage_phone, Formatter.formatShortFileSize(this@SettingsActivity, loc.freeBytes))
                    loc.mounted -> getString(R.string.settings_storage_sd, Formatter.formatShortFileSize(this@SettingsActivity, loc.freeBytes))
                    else -> getString(R.string.settings_storage_sd_missing)
                }
                isEnabled = loc.mounted
            }
            storage.addView(rb)
            if (loc.kind == current) storage.check(rb.id)
        }
        storage.setOnCheckedChangeListener { group, checked ->
            val to = group.findViewById<View>(checked)?.tag as? StorageLocation ?: return@setOnCheckedChangeListener
            if (to != current) pickStorage(to)
        }
    }

    private fun pickStorage(to: StorageLocation) {
        val finished = downloads.store.all().any { it.state == DownloadState.DONE }
        if (!finished) {
            lifecycleScope.launch { settings.setStorage(to); renderStorage() }
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.settings_move_title)
            .setMessage(if (to == StorageLocation.SD) R.string.settings_move_to_sd else R.string.settings_move_to_phone)
            .setPositiveButton(R.string.settings_move_yes) { _, _ ->
                lifecycleScope.launch {
                    downloads.locations.move(to)
                    Toast.makeText(this@SettingsActivity, R.string.settings_move_started, Toast.LENGTH_SHORT).show()
                    renderStorage()
                }
            }
            .setNegativeButton(R.string.settings_move_no) { _, _ -> lifecycleScope.launch { settings.setStorage(to); renderStorage() } }
            .setOnCancelListener { lifecycleScope.launch { renderStorage() } }
            .show()
    }

    // ---- notifications ----

    private fun renderNotify() {
        if (!::notifyStatus.isInitialized) return
        val on = NotifyPermission.enabled(this)
        notifyStatus.setText(if (on) R.string.settings_notify_on else R.string.settings_notify_off)
        notifyAllow.visibility = if (on) View.GONE else View.VISIBLE
    }

    private fun allowNotifications() {
        lifecycleScope.launch {
            val missing = NotifyPermission.missing(this@SettingsActivity)
            // the dialog can be shown when it was never shown, or Android still offers it (the person said no only once)
            val dialogPossible = missing && // only Android 13+ has the runtime permission
                (!settings.notifyPermissionAsked.first() || shouldShowRequestPermissionRationale(android.Manifest.permission.POST_NOTIFICATIONS))
            if (dialogPossible) {
                settings.setNotifyPermissionAsked()
                NotifyPermission.request(askNotify)
            } else {
                try { startActivity(NotifyPermission.systemSettings(this@SettingsActivity)) } catch (_: ActivityNotFoundException) { }
            }
        }
    }

    // ---- server ----

    private fun askServer() {
        if (busy) return
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = getString(R.string.setup_address_example)
            setText(origin?.let(::display) ?: "")
            setSingleLine()
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.settings_server_prompt)
            .setView(input)
            .setPositiveButton(R.string.setup_connect) { _, _ -> onNewAddress(input.text.toString()) }
            .setNegativeButton(R.string.settings_cancel, null)
            .show()
    }

    private fun onNewAddress(text: String) {
        val next = ServerAddress.normalize(text).getOrElse {
            Toast.makeText(this, R.string.setup_error_invalid, Toast.LENGTH_LONG).show()
            return
        }
        if (origin?.origin() == next.origin()) {
            Toast.makeText(this, R.string.settings_server_same, Toast.LENGTH_SHORT).show()
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.settings_server_confirm_title)
            .setMessage(getString(R.string.settings_server_confirm, display(next)))
            .setPositiveButton(R.string.settings_server_confirm_yes) { _, _ -> changeServer(next) }
            .setNegativeButton(R.string.settings_cancel, null)
            .show()
    }

    private fun changeServer(next: HttpUrl) = runBusy({ it.leaveServer() }) { app ->
        // the normal setup check of the new address; a failure stays on the setup screen with the address filled in
        SetupActivity.intent(app, display(next))
    }

    // ---- sign out ----

    private fun confirmSignOut() {
        if (busy) return
        AlertDialog.Builder(this)
            .setTitle(R.string.settings_sign_out_confirm_title)
            .setMessage(R.string.settings_sign_out_confirm)
            .setPositiveButton(R.string.settings_sign_out_yes) { _, _ -> signOut() }
            .setNegativeButton(R.string.settings_cancel, null)
            .show()
    }

    // a fresh shell afterwards: the web UI of the same server, now on its sign-in page
    private fun signOut() = runBusy({ it.signOut() }) { app -> Intent(app, ShellActivity::class.java) }

    /**
     * Runs [work] in the process scope (leaving the screen or a recreation must not stop a half-done reset), then starts [next] as
     * a new task, which also closes this screen and everything below it.
     */
    private fun runBusy(work: suspend (DeviceReset) -> Unit, next: (Context) -> Intent) {
        busy = true
        progress.visibility = View.VISIBLE
        setEnabled(findViewById(R.id.settings_root), false)
        val app = applicationContext
        val r = reset()
        downloads.scope.launch {
            try {
                work(r)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // what could be cleared is cleared; the next screen still opens (a disabled screen would be a dead end)
                Log.w(TAG, "reset incomplete: ${e.javaClass.simpleName}")
            }
            withContext(Dispatchers.Main) {
                app.startActivity(next(app).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                done?.invoke()
            }
        }
    }

    /** tests: called after a reset finished */
    @VisibleForTesting
    internal var done: (() -> Unit)? = null

    private fun setEnabled(v: View, on: Boolean) {
        v.isEnabled = on
        if (v is android.view.ViewGroup) for (i in 0 until v.childCount) setEnabled(v.getChildAt(i), on)
    }

    companion object {
        private const val TAG = "FFSettings"

        /** Opens the settings; an open screen is reused (a double tap in the web UI, or one below the offline list). */
        fun intent(context: Context): Intent =
            Intent(context, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        /** `friend.example.com`, with the port only when it is not 443 */
        fun display(origin: HttpUrl): String = if (origin.port == 443) origin.host else "${origin.host}:${origin.port}"
    }
}
