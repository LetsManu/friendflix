// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class VersionTest {
    @Test
    fun versionCodeFromSemver() {
        assertEquals(20001, versionCode("2.0.1"))
        assertEquals(20000, versionCode("2.0.0"))
        assertEquals(100203, versionCode("10.2.3"))
    }

    @Test
    fun invalidVersionThrows() {
        for (bad in listOf("", "2", "2.0", "2.0.0.1", "a.b.c", "2.0.x", "-1.0.0", "2.100.0", "2.0.100", "v2.0.0", "2.0.0-rc1")) {
            assertThrows("should reject '$bad'", IllegalArgumentException::class.java) { versionCode(bad) }
        }
    }

    @Test
    fun parsesVersionFromVersionJson() {
        assertEquals("2.0.0", versionFromJson("""{ "version": "2.0.0", "codename": "Brezel" }"""))
        assertThrows(IllegalArgumentException::class.java) { versionFromJson("{}") }
    }
}
