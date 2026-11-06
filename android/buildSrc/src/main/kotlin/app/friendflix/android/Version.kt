// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android

// Shared by the Gradle build (buildSrc) and the app's unit tests (added as a test source dir), so the
// rule that turns the server version into the Android versionCode is written and tested exactly once.

private val SEMVER = Regex("""(\d{1,4})\.(\d{1,2})\.(\d{1,2})""")

/** `major*10000 + minor*100 + patch`; minor and patch must be below 100. Anything but plain `x.y.z` throws. */
fun versionCode(v: String): Int {
    val m = SEMVER.matchEntire(v) ?: throw IllegalArgumentException("not a plain x.y.z version: '$v'")
    val (major, minor, patch) = m.destructured
    return major.toInt() * 10_000 + minor.toInt() * 100 + patch.toInt()
}

private val VERSION_FIELD = Regex(""""version"\s*:\s*"([^"]*)"""")

/** The `version` field of the repository's version.json. */
fun versionFromJson(json: String): String =
    VERSION_FIELD.find(json)?.groupValues?.get(1) ?: throw IllegalArgumentException("version.json has no \"version\" field")
