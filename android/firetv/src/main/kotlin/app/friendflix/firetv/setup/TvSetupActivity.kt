// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.setup

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import app.friendflix.android.setup.ProbeResult
import app.friendflix.android.setup.ServerProbe
import app.friendflix.android.shell.ServerAddressError
import app.friendflix.android.shell.ServerAddressException
import app.friendflix.android.shell.origin
import app.friendflix.firetv.BuildConfig
import app.friendflix.firetv.R
import app.friendflix.firetv.TvSettings
import app.friendflix.firetv.shell.TvShellActivity
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

/**
 * The start screen (the LG app's setup page, natively): a stored server is checked with `GET /api/version` and opened; a failed check
 * shows the reason with Retry and Change server; without a stored server, or on *Change server* from the web UI, the address form asks
 * for the server and checks it before saving it. Back leaves the screen (the keyboard closes first, as Android does by itself).
 */
class TvSetupActivity : ComponentActivity() {
    private lateinit var settings: TvSettings
    private val probe = ServerProbe(appVersion = BuildConfig.VERSION_NAME)

    private lateinit var checking: TextView
    private lateinit var failure: View
    private lateinit var failureText: TextView
    private lateinit var retry: Button
    private lateinit var form: View
    private lateinit var address: EditText
    private lateinit var error: TextView
    private lateinit var connect: Button

    /** the server the failure card is about (Retry checks it again, Change server prefills it) */
    private var failedOrigin: HttpUrl? = null
    private var job: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Launched from the home screen while the app's task already runs (the shell, or this screen mid-check): the task comes to the
        // front as it is; no second check and no second shell.
        if (!isTaskRoot && TvSetupFlow.isLauncherIntent(intent.action, intent.categories)) {
            finish()
            return
        }
        setContentView(R.layout.activity_tv_setup)
        settings = TvSettings.from(applicationContext)
        limitWidth()

        checking = findViewById(R.id.tv_setup_checking)
        failure = findViewById(R.id.tv_setup_failure)
        failureText = findViewById(R.id.tv_setup_failure_text)
        retry = findViewById(R.id.tv_setup_retry)
        form = findViewById(R.id.tv_setup_form)
        address = findViewById(R.id.tv_setup_address)
        error = findViewById(R.id.tv_setup_error)
        connect = findViewById(R.id.tv_setup_connect)

        retry.setOnClickListener { failedOrigin?.let { check(it) } }
        findViewById<Button>(R.id.tv_setup_change).setOnClickListener {
            error.text = ""
            showForm(failedOrigin?.origin() ?: "")
        }
        connect.setOnClickListener { submit() }
        address.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) { submit(); true } else false
        }

        val restoredForm = savedInstanceState?.getBoolean(STATE_FORM) == true
        lifecycleScope.launch {
            val stored = settings.serverOrigin.first()
            val change = intent.getBooleanExtra(EXTRA_CHANGE, false)
            when {
                // recreated while the form showed: the field keeps its own text
                restoredForm -> showForm(null)
                TvSetupFlow.startMode(stored, change) == TvSetupMode.CHECK -> check(stored!!)
                else -> showForm(TvSetupFlow.prefill(stored, intent.getStringExtra(EXTRA_ADDRESS)))
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::form.isInitialized) outState.putBoolean(STATE_FORM, form.isVisible)
    }

    /** The content column is at most 1100dp wide and centred (the LG page's 1100px column). */
    private fun limitWidth() {
        val content = findViewById<View>(R.id.tv_setup_content)
        val max = (MAX_WIDTH_DP * resources.displayMetrics.density).toInt()
        val screen = resources.displayMetrics.widthPixels
        content.layoutParams = (content.layoutParams as FrameLayout.LayoutParams).apply {
            width = if (screen > max) max else FrameLayout.LayoutParams.MATCH_PARENT
        }
    }

    private fun show(section: View) {
        for (s in listOf(checking, failure, form)) s.isVisible = s === section
    }

    /** Check the stored server: open it, or show the failure card. */
    private fun check(origin: HttpUrl) {
        if (job?.isActive == true) return
        checking.text = getString(R.string.tv_opening, origin.origin())
        show(checking)
        job = lifecycleScope.launch {
            val result = probe.probe(origin)
            val message = TvSetupFlow.probeMessage(result)
            if (message == null) {
                settings.setAuthOrigin((result as ProbeResult.Ok).authOrigin)
                openShell()
            } else {
                showFailure(origin, message)
            }
        }
    }

    private fun showFailure(origin: HttpUrl, message: Int) {
        failedOrigin = origin
        failureText.setText(message)
        show(failure)
        retry.requestFocus()
    }

    /** The form, with [prefill] in the field (null keeps what is there). */
    private fun showForm(prefill: String?) {
        if (prefill != null) {
            address.setText(prefill)
            address.setSelection(prefill.length)
        }
        show(form)
        address.requestFocus()
    }

    /** Connect: validate, check, save, open. */
    private fun submit() {
        if (job?.isActive == true) return
        val text = address.text.toString()
        val origin = TvSetupFlow.validate(text).getOrElse {
            val reason = (it as? ServerAddressException)?.error ?: ServerAddressError.INVALID
            error.setText(TvSetupFlow.addressMessage(text, reason))
            return
        }
        error.text = ""
        address.setText(origin.origin())
        setBusy(true)
        job = lifecycleScope.launch {
            val result = probe.probe(origin)
            val message = TvSetupFlow.probeMessage(result)
            if (message == null) {
                settings.setServer(origin, (result as ProbeResult.Ok).authOrigin)
                openShell()
            } else {
                setBusy(false)
                error.setText(message)
                connect.requestFocus()
            }
        }
    }

    /** The button says "Checking…" but stays enabled and focused (a disabled button would drop the D-pad focus); [submit] ignores it meanwhile. */
    private fun setBusy(busy: Boolean) {
        connect.setText(if (busy) R.string.tv_setup_checking else R.string.tv_setup_connect)
    }

    private fun openShell() {
        startActivity(Intent(this, TvShellActivity::class.java))
        finish()
    }

    companion object {
        /** true: open the form (the web UI's *Change server*), even with a stored server */
        const val EXTRA_CHANGE = "app.friendflix.firetv.CHANGE"
        /** the address to prefill the form with */
        const val EXTRA_ADDRESS = "app.friendflix.firetv.ADDRESS"

        private const val STATE_FORM = "form"
        private const val MAX_WIDTH_DP = 1100

        /** The form, prefilled with [current] (the server the shell shows). */
        fun changeIntent(context: Context, current: String): Intent =
            Intent(context, TvSetupActivity::class.java).putExtra(EXTRA_CHANGE, true).putExtra(EXTRA_ADDRESS, current)
    }
}
