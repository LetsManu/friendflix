// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The tray icon (spec §5): open, the server address (read-only), settings, quit.
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::shell;

const SERVER_ITEM: &str = "server";

/// The read-only server line (kept so it can change when the address changes).
pub struct ServerItem(pub MenuItem<Wry>);

pub fn server_text(server: Option<&str>) -> String {
    match server {
        Some(s) => format!("Server: {s}"),
        None => "No server set".to_string(),
    }
}

pub fn create(app: &AppHandle, server: Option<&str>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open FriendFlix", true, None::<&str>)?;
    let server_item =
        MenuItem::with_id(app, SERVER_ITEM, server_text(server), false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &server_item,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.manage(ServerItem(server_item));
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("FriendFlix")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => shell::focus_main(app),
            "settings" => shell::open_settings(app),
            "quit" => {
                shell::remember_window(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                shell::focus_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn set_server(app: &AppHandle, server: Option<&str>) {
    if let Some(item) = app.try_state::<ServerItem>() {
        let _ = item.0.set_text(server_text(server));
    }
}
