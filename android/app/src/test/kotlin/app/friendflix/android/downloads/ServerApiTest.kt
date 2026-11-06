// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.downloads

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ServerApiTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private lateinit var api: ServerApi

    @Before fun setUp() {
        env = TestEnv(tmp.root)
        api = ServerApi(env.server.url("/"), OkHttpClient(), env.cookies)
    }
    @After fun tearDown() { env.close() }

    @Test fun cookieJarOnlyServesTheConfiguredOrigin() {
        val cookies = FakeCookies().apply { jar["https://friend.example.com"] = "ff_sid=abc; other=1" }
        val jar = ServerCookieJar("https://friend.example.com".toHttpUrl(), cookies)
        assertEquals(listOf("ff_sid", "other"), jar.loadForRequest("https://friend.example.com/media/d/x".toHttpUrl()).map { it.name })
        assertTrue(jar.loadForRequest("https://friend.example.com:8443/x".toHttpUrl()).isEmpty())
        assertTrue(jar.loadForRequest("https://evil.example.net/x".toHttpUrl()).isEmpty())
        assertTrue(jar.loadForRequest("http://friend.example.com/x".toHttpUrl()).isEmpty())
        assertTrue(jar.loadForRequest("https://sub.friend.example.com/x".toHttpUrl()).isEmpty())
        val c = okhttp3.Cookie.parse("https://evil.example.net/".toHttpUrl(), "a=b")!!
        jar.saveFromResponse("https://evil.example.net/".toHttpUrl(), listOf(c))
        assertTrue(cookies.written.isEmpty())
        jar.saveFromResponse("https://friend.example.com/".toHttpUrl(), listOf(okhttp3.Cookie.parse("https://friend.example.com/".toHttpUrl(), "ff_sid=new; Path=/; Secure; HttpOnly")!!))
        assertEquals(1, cookies.written.size)
    }

    @Test fun requestsCarryTheSessionCookieAndProfile() {
        val a = api.licence(LIC, PROFILE)
        assertTrue(a is LicenceAnswer.Found)
        val l = (a as LicenceAnswer.Found).licence
        assertEquals("pending", l.status)
        assertEquals("ready", l.prepStatus)
        assertEquals("/media/d/$LIC", l.fileUrl)
        assertEquals(TITLE, l.title)
        assertEquals(env.fake.expiresAt.toEpochMilli(), l.expiresAt)
        assertEquals(2, l.subtitles.size)
        val r = env.fake.requests.single()
        assertEquals("ff_sid=s3cret", r.headers["cookie"])
        assertEquals(PROFILE, r.headers["x-ff-profile"])
    }

    @Test fun licenceAnswers() {
        env.fake.licenceCode = 404
        assertEquals(LicenceAnswer.Gone, api.licence(LIC, PROFILE))
        env.fake.licenceError = "downloads_disabled"
        assertEquals(LicenceAnswer.Wait, api.licence(LIC, PROFILE))
        env.fake.licenceCode = 409
        assertEquals(LicenceAnswer.Wait, api.licence(LIC, PROFILE))
        env.fake.licenceCode = 403
        env.fake.licenceError = "device_pending"
        assertEquals(LicenceAnswer.Wait, api.licence(LIC, PROFILE))
        env.fake.licenceCode = 500
        assertEquals(LicenceAnswer.Wait, api.licence(LIC, PROFILE))
        env.fake.unauthorized = true
        try { api.licence(LIC, PROFILE); fail() } catch (_: SessionExpired) {}
    }

    @Test fun checkUsesCsrf() {
        assertEquals(CheckAnswer.Valid, api.check(LIC, PROFILE))
        env.fake.checkRevoked = true
        assertEquals(CheckAnswer.Revoked, api.check(LIC, PROFILE))
        val r = env.fake.api("/api/downloads/check").last()
        assertEquals("tok", r.headers["x-csrf-token"])
        assertEquals(1, env.fake.api("/api/me").size) // token cached
    }

    @Test fun onlySameOriginPaths() {
        assertNull(api.resolve("https://evil.example.net/media/d/x"))
        assertNull(api.resolve("//evil.example.net/media/d/x"))
        assertNull(api.resolve("media/d/x"))
        assertEquals(env.server.url("/media/d/x"), api.resolve("/media/d/x"))
    }

    @Test fun deleteLicence() {
        assertEquals(true, api.deleteLicence(LIC, PROFILE))
        assertEquals("DELETE", env.fake.requests.last().method)
        assertEquals("tok", env.fake.requests.last().headers["x-csrf-token"])
    }
}
