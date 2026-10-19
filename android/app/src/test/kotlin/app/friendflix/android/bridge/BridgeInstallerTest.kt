// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.bridge

import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.shell.OriginPolicy
import app.friendflix.android.shell.WebViewFactory
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BridgeInstallerTest {
    @Test fun withoutWebViewSupportNothingIsInstalledAndNothingCrashes() {
        // Robolectric has no real WebView provider, so WEB_MESSAGE_LISTENER is reported unsupported: the shell must still come up.
        val policy = OriginPolicy("https://friend.example.com".toHttpUrl())
        val bridge = NativeBridge(policy, NoPlayerLauncher, NoDownloadSink, Capabilities(false, false, false)) {}
        val view = WebViewFactory.create(ApplicationProvider.getApplicationContext(), policy, "2.0.0", bridge) {}
        assertFalse(BridgeInstaller.install(view, policy, bridge))
    }
}
