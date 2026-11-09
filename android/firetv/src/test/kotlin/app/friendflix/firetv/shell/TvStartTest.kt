// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Test

class TvStartTest {
    @Test fun probeOnlyTheFirstTimeForAServer() {
        val o = "https://friend.example.com".toHttpUrl()
        assertEquals("https://friend.example.com/tv?ff_app=firetv&probe=1", TvStart.url(o, null))
        assertEquals("https://friend.example.com/tv?ff_app=firetv&probe=1", TvStart.url(o, "https://192.0.2.4"))
        assertEquals("https://friend.example.com/tv?ff_app=firetv", TvStart.url(o, "https://friend.example.com"))
        assertEquals("https://192.0.2.4:8443/tv?ff_app=firetv", TvStart.url("https://192.0.2.4:8443".toHttpUrl(), "https://192.0.2.4:8443"))
    }
}
