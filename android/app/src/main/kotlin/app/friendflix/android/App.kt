// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android

import android.app.Application

/** Process-wide entry point. Wiring (settings, downloads, notifications) is added by later tasks. */
class App : Application()
