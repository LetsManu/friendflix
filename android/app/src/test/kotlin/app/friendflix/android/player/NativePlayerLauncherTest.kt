// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import app.friendflix.android.bridge.PlayRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** PlayerLauncher must be idempotent per request: the web UI may re-send a play after its 5 s bridge timeout. */
@RunWith(RobolectricTestRunner::class)
class NativePlayerLauncherTest {
    private var clock = 10_000L
    private val started = mutableListOf<Pair<PlayRequest, String>>()
    private val launcher = NativePlayerLauncher(start = { req, token -> started += req to token }, now = { clock })
    private val req = PlayRequest(ITEM, PROFILE, startMs = 61_000, mediaSourceId = null, audio = "ger", subtitle = null)

    @Test fun aRetriedPlayDoesNotOpenASecondPlayer() {
        assertTrue(launcher.launch(req))
        clock += 5_500 // the web gave up after 5 s and asks again
        assertTrue("the retry is answered with true", launcher.launch(req.copy()))
        assertEquals(1, started.size)
    }

    @Test fun anotherTitleStartsRightAway() {
        launcher.launch(req)
        launcher.launch(req.copy(itemId = OTHER))
        assertEquals(listOf(ITEM, OTHER), started.map { it.first.itemId })
    }

    @Test fun theSameTitleAgainAfterThePlayerClosedStartsAgain() {
        launcher.launch(req)
        launcher.ended(started.single().second)
        clock += 1_000
        launcher.launch(req)
        assertEquals(2, started.size)
    }

    @Test fun theSameRequestMuchLaterStartsAgain() {
        launcher.launch(req)
        clock += NativePlayerLauncher.RETRY_WINDOW_MS + 1
        launcher.launch(req)
        assertEquals(2, started.size)
    }

    @Test fun eachStartHasItsOwnToken() {
        launcher.launch(req)
        launcher.launch(req.copy(itemId = OTHER))
        assertEquals(2, started.map { it.second }.toSet().size)
    }

    @Test fun aFailingStartIsDeclined() {
        val failing = NativePlayerLauncher(start = { _, _ -> throw IllegalStateException("no activity") }, now = { clock })
        assertEquals(false, failing.launch(req))
        // and does not block a later attempt
        assertEquals(false, failing.launch(req))
    }

    companion object {
        const val ITEM = "5f1e2d3c4b5a69788796a5b4c3d2e1f0"
        const val OTHER = "0a0b0c0d0e0f00112233445566778899"
        const val PROFILE = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9"
    }
}
