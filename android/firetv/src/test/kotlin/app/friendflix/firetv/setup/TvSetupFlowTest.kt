// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.setup

import app.friendflix.android.setup.ProbeResult
import app.friendflix.android.shell.ServerAddressError
import app.friendflix.android.shell.ServerAddressException
import app.friendflix.android.shell.origin
import app.friendflix.firetv.R
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TvSetupFlowTest {
    private fun errorOf(s: String) = (TvSetupFlow.validate(s).exceptionOrNull() as ServerAddressException).error

    @Test fun startsWithTheFormWithoutAServerOrOnChange() {
        assertEquals(TvSetupMode.FORM, TvSetupFlow.startMode(null, change = false))
        assertEquals(TvSetupMode.FORM, TvSetupFlow.startMode("https://friend.example.com".toHttpUrl(), change = true))
        assertEquals(TvSetupMode.CHECK, TvSetupFlow.startMode("https://friend.example.com".toHttpUrl(), change = false))
    }

    @Test fun acceptsHostsPortsAndIpv6() {
        assertEquals("https://friend.example.com", TvSetupFlow.validate(" friend.example.com/tv?x=1 ").getOrThrow().origin())
        assertEquals("https://192.0.2.10:8443", TvSetupFlow.validate("https://192.0.2.10:8443").getOrThrow().origin())
        assertEquals("https://[2001:db8::1]", TvSetupFlow.validate("[2001:db8::1]").getOrThrow().origin())
    }

    @Test fun addressMessages() {
        assertEquals(R.string.tv_error_empty, TvSetupFlow.addressMessage("   ", ServerAddressError.INVALID))
        assertEquals(R.string.tv_error_empty, TvSetupFlow.addressMessage("", errorOf("")))
        assertEquals(R.string.tv_error_insecure, TvSetupFlow.addressMessage("http://friend.example.com", errorOf("http://friend.example.com")))
        assertEquals(R.string.tv_error_invalid, TvSetupFlow.addressMessage("friend", errorOf("friend")))
        assertEquals(R.string.tv_error_invalid, TvSetupFlow.addressMessage("ftp://friend.example.com", errorOf("ftp://friend.example.com")))
        assertEquals(R.string.tv_error_invalid, TvSetupFlow.addressMessage("user@friend.example.com", errorOf("user@friend.example.com")))
    }

    @Test fun probeMessages() {
        assertNull(TvSetupFlow.probeMessage(ProbeResult.Ok("3.0.0", null)))
        assertEquals(R.string.tv_error_unreachable, TvSetupFlow.probeMessage(ProbeResult.Unreachable))
        assertEquals(R.string.tv_error_not_friendflix, TvSetupFlow.probeMessage(ProbeResult.NotFriendFlix))
        assertEquals(R.string.tv_error_tls, TvSetupFlow.probeMessage(ProbeResult.TlsProblem))
        assertEquals(R.string.tv_error_app_too_old, TvSetupFlow.probeMessage(ProbeResult.AppTooOld))
        assertEquals(R.string.tv_error_server_too_old, TvSetupFlow.probeMessage(ProbeResult.ServerTooOld))
    }

    @Test fun prefillPrefersTheHandedOverAddress() {
        assertEquals("https://192.0.2.7", TvSetupFlow.prefill("https://friend.example.com".toHttpUrl(), "https://192.0.2.7"))
        assertEquals("https://friend.example.com", TvSetupFlow.prefill("https://friend.example.com".toHttpUrl(), null))
        assertEquals("", TvSetupFlow.prefill(null, null))
    }

    @Test fun onlyTheHomeScreenStartIsALauncherIntent() {
        assertTrue(TvSetupFlow.isLauncherIntent("android.intent.action.MAIN", setOf("android.intent.category.LAUNCHER")))
        assertTrue(TvSetupFlow.isLauncherIntent("android.intent.action.MAIN", setOf("android.intent.category.LEANBACK_LAUNCHER")))
        assertFalse(TvSetupFlow.isLauncherIntent(null, null)) // the shell's Change server / the guard's hand-over
        assertFalse(TvSetupFlow.isLauncherIntent("android.intent.action.MAIN", null))
    }
}
