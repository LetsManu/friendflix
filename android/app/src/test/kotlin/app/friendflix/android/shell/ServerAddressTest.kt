// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {
    private fun ok(input: String) = ServerAddress.normalize(input).getOrThrow().origin()

    private fun failure(input: String): ServerAddressError {
        val r = ServerAddress.normalize(input)
        assertTrue("expected failure for '$input'", r.isFailure)
        return (r.exceptionOrNull() as ServerAddressException).error
    }

    @Test
    fun bareHostBecomesHttps() = assertEquals("https://friend.example.com", ok("friend.example.com"))

    @Test
    fun pathQueryAndFragmentAreDropped() {
        assertEquals("https://friend.example.com", ok("https://friend.example.com/home/"))
        assertEquals("https://friend.example.com", ok("friend.example.com/a?b=c#d"))
    }

    @Test
    fun whitespaceAndCaseAreNormalized() = assertEquals("https://friend.example.com", ok("  HTTPS://Friend.Example.com  "))

    @Test
    fun portIsKeptDefaultPortDropped() {
        assertEquals("https://friend.example.com:8443", ok("https://friend.example.com:8443"))
        assertEquals("https://friend.example.com", ok("https://friend.example.com:443"))
    }

    @Test
    fun httpIsInsecure() {
        assertEquals(ServerAddressError.INSECURE, failure("http://friend.example.com"))
        assertEquals(ServerAddressError.INSECURE, failure("HTTP://friend.example.com:8080/x"))
    }

    @Test
    fun emptyAndGarbageAreInvalid() {
        for (bad in listOf("", "   ", "garbage", "not a url", "https://", "://x.example.com", "ftp://friend.example.com", "https://user:pw@friend.example.com", "https://friend.example.com:99999")) {
            assertEquals("input '$bad'", ServerAddressError.INVALID, failure(bad))
        }
    }
}
