# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Release builds are minified and resource-shrunk. The bridge needs no keep rules: it is a WebMessageListener (no reflection, no @JavascriptInterface).
# The Cast framework instantiates its options provider by the class name in the manifest meta-data.
-keep class app.friendflix.android.cast.CastOptionsProvider { <init>(); }
