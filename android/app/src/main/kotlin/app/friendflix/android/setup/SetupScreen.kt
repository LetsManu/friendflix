// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.setup

import android.content.Intent
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import app.friendflix.android.BuildConfig
import app.friendflix.android.R
import app.friendflix.android.settings.AppSettings
import app.friendflix.android.shell.ServerAddress
import app.friendflix.android.shell.ServerAddressError
import app.friendflix.android.shell.ServerAddressException
import app.friendflix.android.shell.ShellActivity
import kotlinx.coroutines.launch

/** First run: ask for the server address, check it really is a compatible FriendFlix server, save it, open the shell. */
class SetupActivity : ComponentActivity() {
    private lateinit var address: EditText
    private lateinit var connect: Button
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private val probe = ServerProbe(appVersion = BuildConfig.VERSION_NAME)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        val root = findViewById<View>(R.id.setup_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        address = findViewById(R.id.setup_address)
        connect = findViewById(R.id.setup_connect)
        status = findViewById(R.id.setup_status)
        progress = findViewById(R.id.setup_progress)
        connect.setOnClickListener { submit() }
        address.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) { submit(); true } else false
        }
    }

    private fun submit() {
        val origin = ServerAddress.normalize(address.text.toString()).getOrElse {
            show(if ((it as? ServerAddressException)?.error == ServerAddressError.INSECURE) R.string.setup_error_insecure else R.string.setup_error_invalid)
            return
        }
        setBusy(true)
        lifecycleScope.launch {
            val result = probe.probe(origin)
            if (result is ProbeResult.Ok) {
                AppSettings.from(applicationContext).setServerOrigin(origin)
                startActivity(Intent(this@SetupActivity, ShellActivity::class.java))
                finish()
                return@launch
            }
            setBusy(false)
            show(
                when (result) {
                    ProbeResult.AppTooOld -> R.string.setup_error_app_too_old
                    ProbeResult.ServerTooOld -> R.string.setup_error_server_too_old
                    ProbeResult.NotFriendFlix -> R.string.setup_error_not_friendflix
                    ProbeResult.TlsProblem -> R.string.setup_error_tls
                    else -> R.string.setup_error_unreachable
                },
            )
        }
    }

    private fun setBusy(busy: Boolean) {
        progress.visibility = if (busy) View.VISIBLE else View.GONE
        connect.isEnabled = !busy
        address.isEnabled = !busy
        if (busy) status.text = ""
    }

    private fun show(message: Int) { status.setText(message) }
}
