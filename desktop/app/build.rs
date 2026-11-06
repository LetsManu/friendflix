// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The app manifest makes every command need an explicit permission (`allow-<command>`); capabilities/ grants them.
//! `mpv/` is a bundled resource that the release build downloads (desktop/player/mpv.lock); without it (development) an
//! empty folder keeps the resource step working, and the app tells at runtime that the player is missing.
fn main() {
    std::fs::create_dir_all("mpv").expect("mpv resource folder");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bridge_message",
            "probe_server",
            "get_settings",
            "set_settings",
        ]),
    ))
    .expect("tauri build");
}
