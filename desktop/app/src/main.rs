// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! FriendFlix for Windows: a window around the server's web app with a narrow native bridge (see `shell` and
//! `bridge_cmd`) and the mpv player host (`player`); `updater` keeps it up to date.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge_cmd;
mod logging;
mod player;
mod settings;
mod shell;
mod tray;
mod updater;

use tauri::{Manager, WindowEvent};

use crate::settings::Settings;
use crate::shell::AppState;

fn main() {
    logging::init();
    let settings = Settings::load();
    tauri::Builder::default()
        // first: a second start hands its arguments (a friendflix:// link) to this one and quits
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            shell::focus_main(app);
            shell::handle_args(app, &argv);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new(settings))
        .invoke_handler(tauri::generate_handler![
            bridge_cmd::bridge_message,
            shell::probe_server,
            shell::get_settings,
            shell::set_settings
        ])
        .setup(|app| {
            // installed builds register friendflix:// in the installer; development builds register it here
            #[cfg(all(debug_assertions, windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("friendflix:// not registered: {e}");
                }
            }
            let handle = app.handle();
            log::info!("FriendFlix {} starting", handle.package_info().version);
            let s = handle.state::<AppState>().settings();
            tray::create(handle, s.server.as_deref())?;
            let args: Vec<String> = std::env::args().skip(1).collect();
            shell::start(handle, &s, &args);
            updater::schedule(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the main window quits the app (the tray stays only while the window is open)
            if let WindowEvent::CloseRequested { .. } = event {
                if shell::is_main(window) {
                    player::stop();
                    shell::remember_window(window.app_handle());
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("FriendFlix could not start");
}
