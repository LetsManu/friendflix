// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import android.net.Uri
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class OriginPolicyTest {
    private val policy = OriginPolicy("https://friend.example.com".toHttpUrl())
    private fun app(url: String) = policy.isAppOrigin(Uri.parse(url))

    @Test
    fun sameOriginIsApp() {
        assertTrue(app("https://friend.example.com/"))
        assertTrue(app("https://friend.example.com/watch/1?x=y#z"))
        assertTrue(app("https://FRIEND.example.com:443/x"))
    }

    @Test
    fun otherPortIsNotApp() = assertFalse(app("https://friend.example.com:8443/"))

    @Test
    fun subdomainAndLookalikesAreNotApp() {
        assertFalse(app("https://sub.friend.example.com/"))
        assertFalse(app("https://friend.example.com.evil.test/"))
        assertFalse(app("https://friend.example.com@evil.test/"))
        assertFalse(app("https://evil.test/friend.example.com"))
        assertFalse(app("https://example.com/"))
    }

    @Test
    fun otherSchemesAreNotApp() {
        assertFalse(app("http://friend.example.com/"))
        assertFalse(app("javascript:alert(1)"))
        assertFalse(app("intent://friend.example.com/#Intent;end"))
        assertFalse(app("file:///etc/hosts"))
        assertFalse(app("//friend.example.com/"))
    }

    @Test
    fun customPortOrigin() {
        val p = OriginPolicy("https://friend.example.com:8443".toHttpUrl())
        assertTrue(p.isAppOrigin(Uri.parse("https://friend.example.com:8443/x")))
        assertFalse(p.isAppOrigin(Uri.parse("https://friend.example.com/x")))
    }
}
