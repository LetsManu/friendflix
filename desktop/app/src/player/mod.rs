// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The mpv player host (spec §4, §6): one player at a time, on its own thread. `start` answers the bridge's `play` at
//! once; the session's logic lives in `friendflix_core::session`, this module only wires mpv, the pipe, the cookie and
//! the shell. Development builds on other systems leave playing to the web player.
#![cfg_attr(not(windows), allow(dead_code))]

pub mod cookies;
pub mod ipc;
pub mod mpv;
pub mod session;

use std::sync::{Mutex, MutexGuard};

use friendflix_core::bridge::PlayRequest;
use tauri::{AppHandle, Manager};

use crate::shell::AppState;

/// The player that runs: mpv's process id (once started) and its pipe (once connected).
#[derive(Default)]
struct Running {
    pid: Option<u32>,
    #[cfg(windows)]
    ipc: Option<std::sync::Arc<ipc::Ipc>>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn running() -> MutexGuard<'static, Option<Running>> {
    RUNNING.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(windows)]
fn set_running(pid: u32, ipc: Option<std::sync::Arc<ipc::Ipc>>) {
    if let Some(r) = running().as_mut() {
        r.pid = Some(pid);
        r.ipc = ipc;
    }
}

fn clear_running() {
    *running() = None;
}

/// The bridge's `play`: `true` when the native player takes the title. While a player runs, it is focused instead
/// (and `true` keeps the page from playing it too). The profile is remembered for `friendflix://watch` links.
pub fn start(app: &AppHandle, req: PlayRequest) -> bool {
    let s = app
        .state::<AppState>()
        .update(|s| s.set_last_profile(&req.profile_id));
    let Some(server) = s.server_origin() else {
        return false;
    };
    #[cfg_attr(not(windows), allow(unused_mut))] // filled on Windows only
    let mut slot = running();
    if let Some(r) = slot.as_ref() {
        if let Some(pid) = r.pid {
            mpv::focus(pid);
        }
        return true;
    }
    #[cfg(windows)]
    {
        let paths = match app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())
            .and_then(|dir| mpv::Paths::resolve(&dir))
        {
            Ok(p) => p,
            Err(e) => {
                log::error!("player not started: {e}");
                session::tell_async(
                    "The player is missing from this installation, so the title plays in the web player. \
                     Reinstalling FriendFlix brings the player back.",
                );
                return false;
            }
        };
        *slot = Some(Running::default());
        drop(slot);
        let handle = app.clone();
        let spawned = std::thread::Builder::new()
            .name("ff-player".into())
            .spawn(move || session::run(&handle, req, server, s, paths));
        if let Err(e) = spawned {
            log::error!("player thread not started: {e}");
            clear_running();
            return false;
        }
        true
    }
    #[cfg(not(windows))]
    {
        drop(slot);
        let _ = (server, req);
        log::info!("the native player runs on Windows only; the web player plays");
        false
    }
}

/// The app quits: ask a running mpv to quit too (it would otherwise outlive the app).
pub fn stop() {
    #[cfg(windows)]
    {
        let ipc = running().as_ref().and_then(|r| r.ipc.clone());
        if let Some(ipc) = ipc {
            let _ = ipc.command(serde_json::json!(["quit"]));
        }
    }
}
