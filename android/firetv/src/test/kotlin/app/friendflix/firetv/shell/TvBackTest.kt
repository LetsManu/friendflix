// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.firetv.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class TvBackTest {
    @Test fun handledOrBlurredBackDoesNothingMore() {
        assertEquals(BackAction.NONE, TvBack.after("\"handled\"", canGoBack = true))
        assertEquals(BackAction.NONE, TvBack.after("\"blurred\"", canGoBack = false))
    }

    @Test fun unhandledBackWalksHistoryThenExits() {
        assertEquals(BackAction.GO_BACK, TvBack.after("\"unhandled\"", canGoBack = true))
        assertEquals(BackAction.EXIT, TvBack.after("\"unhandled\"", canGoBack = false))
        assertEquals(BackAction.EXIT, TvBack.after("null", canGoBack = false)) // error page: no script ran
        assertEquals(BackAction.EXIT, TvBack.after(null, canGoBack = false))
        assertEquals(BackAction.GO_BACK, TvBack.after("garbage", canGoBack = true))
    }
}
