// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import app.friendflix.firetv.TvSettings
import app.friendflix.firetv.setup.TvSetupActivity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** The server's TV interface in a WebView. For now only the guard: without a saved server it hands over to the start screen. */
class TvShellActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            if (TvSettings.from(applicationContext).serverOrigin.first() == null) {
                startActivity(Intent(this@TvShellActivity, TvSetupActivity::class.java))
                finish()
            }
        }
    }
}
