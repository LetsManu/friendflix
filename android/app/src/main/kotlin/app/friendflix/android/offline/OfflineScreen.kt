// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.offline

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.format.Formatter
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import app.friendflix.android.BuildConfig
import app.friendflix.android.R
import app.friendflix.android.downloads.DownloadRecord
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.settings.AppSettings
import app.friendflix.android.setup.ProbeResult
import app.friendflix.android.setup.ServerProbe
import app.friendflix.android.shell.ShellActivity
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.text.Collator
import kotlin.math.ceil

/**
 * The offline list (plain views, like the setup screen): the last active profile's downloads with size, days left and why one cannot
 * play; Play hands the local files to [Offline.launcher]. Opened by the shell when the server cannot be reached at start and there is
 * something to watch, or through [intent] (Task 11: menu / notification). Reconnect probes the server and goes back to the web UI.
 * It never calls the API itself except through the licence checker on reconnect, and never shows or logs anything but the titles here.
 */
class OfflineActivity : ComponentActivity() {
    private lateinit var offline: Offline
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var reconnect: Button
    private lateinit var progress: ProgressBar
    private lateinit var watch: NetworkWatch

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        offline = Offline.get(applicationContext)
        setContentView(R.layout.activity_offline)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.offline_root)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.setAccessibilityHeading(findViewById(R.id.offline_heading), true)
        list = findViewById(R.id.offline_list)
        status = findViewById(R.id.offline_status)
        reconnect = findViewById(R.id.offline_reconnect)
        progress = findViewById(R.id.offline_progress)
        reconnect.setOnClickListener { reconnect() }
        watch = NetworkWatch(this) { offline.reconnectInBackground() }
        val queue = offline.downloads.queue
        lifecycleScope.launch {
            combine(queue.observe(), offline.checker.keysAvailable) { _, _ -> }.collect { render() }
        }
    }

    override fun onStart() {
        super.onStart()
        watch.start()
    }

    override fun onResume() {
        super.onResume()
        offline.checker.touch()
        lifecycleScope.launch { offline.checker.openKeys() } // keys that were busy may be there now
        render()
    }

    override fun onStop() {
        watch.stop()
        super.onStop()
    }

    private fun reconnect() {
        reconnect.isEnabled = false
        progress.visibility = View.VISIBLE
        status.text = ""
        lifecycleScope.launch {
            val origin = AppSettings.from(applicationContext).serverOrigin.first()
            val result = if (origin == null) ProbeResult.Unreachable else ServerProbe(appVersion = BuildConfig.VERSION_NAME, timeoutMs = PROBE_TIMEOUT_MS).probe(origin)
            reconnect.isEnabled = true
            progress.visibility = View.GONE
            if (!OfflineGate.shouldOpen(result, hasDownloads = true)) {
                offline.reconnectInBackground()
                startActivity(
                    Intent(this@OfflineActivity, ShellActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        .putExtra(ShellActivity.EXTRA_RELOAD, true),
                )
                finish()
            } else {
                status.setText(R.string.offline_still_offline)
            }
        }
    }

    private fun render() {
        val checker = offline.checker
        val items = checker.entries().sortedWith(compareBy(Collator.getInstance()) { it.title })
        list.removeAllViews()
        status.text = when {
            checker.keysAvailable.value == false -> getString(R.string.offline_keys_unavailable)
            items.isEmpty() -> getString(R.string.offline_none)
            else -> ""
        }
        val now = System.currentTimeMillis()
        val inflater = LayoutInflater.from(this)
        for (r in items) {
            val row = inflater.inflate(R.layout.item_offline, list, false)
            row.findViewById<TextView>(R.id.offline_item_title).text = r.title
            row.findViewById<TextView>(R.id.offline_item_meta).text = meta(r, now)
            val block = checker.verdict(r)
            val reason = row.findViewById<TextView>(R.id.offline_item_reason)
            if (block != null) {
                reason.text = getString(reasonText(block))
                reason.visibility = View.VISIBLE
            }
            val play = row.findViewById<Button>(R.id.offline_item_play)
            play.isEnabled = block == null
            play.contentDescription = getString(R.string.offline_play) + " · " + r.title
            play.setOnClickListener { play(r.licenseId) }
            row.tag = r.licenseId
            list.addView(row)
        }
    }

    private fun meta(r: DownloadRecord, now: Long): String {
        val size = Formatter.formatShortFileSize(this, if (r.total > 0) r.total else r.bytes)
        val days = maxOf(0, ceil((r.expiresAt - now) / DAY_MS.toDouble()).toInt())
        val left = resources.getQuantityString(R.plurals.offline_days_left, days, days)
        return getString(if (r.state == DownloadState.DONE) R.string.offline_meta else R.string.offline_meta_unfinished, size, left)
    }

    private fun play(licenseId: String) {
        lifecycleScope.launch {
            when (val res = offline.play(licenseId)) {
                PlayResult.Started -> Unit
                PlayResult.Declined -> Toast.makeText(this@OfflineActivity, R.string.offline_play_failed, Toast.LENGTH_SHORT).show()
                is PlayResult.Blocked -> {
                    Toast.makeText(this@OfflineActivity, reasonText(res.reason), Toast.LENGTH_LONG).show()
                    render()
                }
            }
        }
    }

    companion object {
        private const val DAY_MS = 86_400_000L
        private const val PROBE_TIMEOUT_MS = 5_000L

        /** Opens the offline list (Task 11 menu / notification). */
        fun intent(context: Context): Intent = Intent(context, OfflineActivity::class.java)

        fun reasonText(b: PlayBlock): Int = when (b) {
            PlayBlock.NOT_DONE -> R.string.offline_reason_not_done
            PlayBlock.EXPIRED -> R.string.offline_reason_expired
            PlayBlock.CHECK_IN -> R.string.offline_reason_checkin
            PlayBlock.CLOCK -> R.string.offline_reason_clock
            PlayBlock.KEYS_UNAVAILABLE -> R.string.offline_reason_keys
            PlayBlock.STORAGE_UNAVAILABLE -> R.string.offline_reason_storage
            PlayBlock.FILE_MISSING -> R.string.offline_reason_file_missing
        }
    }
}
