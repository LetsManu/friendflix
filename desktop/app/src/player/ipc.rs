// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! mpv's JSON IPC over `\\.\pipe\friendflix-<hex>` (tokio named-pipe client). Before anything is sent, the pipe's server
//! process must be the mpv child (`GetNamedPipeServerProcessId`) running as the current user (its token user); otherwise
//! the connection is dropped. Commands block their caller (the player thread) until mpv answers; events arrive on a
//! channel that closes when the pipe closes. Nothing that crosses the pipe is logged (the header property holds the cookie).
use friendflix_core::session::MpvEvent;
use serde_json::Value;

/// One line from mpv.
#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    /// the answer to `request_id`: `data` on success, else mpv's error text
    Reply {
        id: u64,
        result: Result<Value, String>,
    },
    Event(MpvEvent),
    Ignore,
}

pub fn classify(line: &[u8]) -> Line {
    let Ok(v) = serde_json::from_slice::<Value>(line) else {
        return Line::Ignore;
    };
    if let Some(ev) = MpvEvent::parse(&v) {
        return Line::Event(ev);
    }
    let Some(id) = v
        .get("request_id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
    else {
        return Line::Ignore;
    };
    let result = match v.get("error").and_then(Value::as_str) {
        Some("success") => Ok(v.get("data").cloned().unwrap_or(Value::Null)),
        Some(e) => Err(e.to_string()),
        None => Err("no answer".to_string()),
    };
    Line::Reply { id, result }
}

#[cfg(windows)]
pub use pipe::Ipc;

#[cfg(windows)]
mod pipe {
    use std::collections::HashMap;
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    use friendflix_core::session::{MpvEvent, PlayerError};
    use serde_json::{json, Value};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use tokio::sync::mpsc as tmpsc;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::{classify, Line};

    const ERROR_PIPE_BUSY: i32 = 231;
    /// A longer line from mpv ends the connection.
    const MAX_LINE: u64 = 4 << 20;
    const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

    type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, PlayerError>>>>>;

    pub struct Ipc {
        out: tmpsc::UnboundedSender<String>,
        pending: Pending,
        next_id: AtomicU64,
        events: Mutex<Option<mpsc::Receiver<MpvEvent>>>,
    }

    impl std::fmt::Debug for Ipc {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("Ipc").finish_non_exhaustive()
        }
    }

    impl Ipc {
        /// Connects to mpv's pipe (it appears shortly after the start), checks its owner and starts the reader and
        /// writer tasks. Call it inside the async runtime.
        pub async fn connect(name: &str, server_pid: u32, timeout: Duration) -> io::Result<Ipc> {
            let deadline = Instant::now() + timeout;
            let client = loop {
                match ClientOptions::new().open(name) {
                    Ok(c) => break c,
                    Err(e)
                        if e.kind() == io::ErrorKind::NotFound
                            || e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {}
                    Err(e) => return Err(e),
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "mpv's pipe did not appear",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            };
            verify_owner(&client, server_pid)?;
            Ok(Ipc::start(client))
        }

        fn start(client: NamedPipeClient) -> Ipc {
            let (read, mut write) = tokio::io::split(client);
            let (out, mut lines) = tmpsc::unbounded_channel::<String>();
            let (events_tx, events_rx) = mpsc::channel();
            let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
            tokio::spawn(async move {
                while let Some(mut line) = lines.recv().await {
                    line.push('\n');
                    if write.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
            let replies = pending.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(read);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    let n = match (&mut reader)
                        .take(MAX_LINE)
                        .read_until(b'\n', &mut buf)
                        .await
                    {
                        Ok(n) => n,
                        Err(_) => break,
                    };
                    if n == 0 || (buf.last() != Some(&b'\n') && n as u64 >= MAX_LINE) {
                        break; // EOF, or a line that is too long
                    }
                    match classify(&buf) {
                        Line::Reply { id, result } => {
                            let tx = replies.lock().ok().and_then(|mut p| p.remove(&id));
                            if let Some(tx) = tx {
                                let _ = tx.send(result.map_err(PlayerError::Failed));
                            }
                        }
                        Line::Event(ev) => {
                            if events_tx.send(ev).is_err() {
                                // nobody listens any more; keep answering commands
                            }
                        }
                        Line::Ignore => {}
                    }
                }
                // EOF: the events channel closes; waiting commands fail
                drop(events_tx);
                if let Ok(mut p) = replies.lock() {
                    p.clear();
                }
            });
            Ipc {
                out,
                pending,
                next_id: AtomicU64::new(1),
                events: Mutex::new(Some(events_rx)),
            }
        }

        /// Sends `{"command": args, "request_id": n}` and waits (blocking, at most 5 s) for mpv's answer.
        pub fn command(&self, args: Value) -> Result<Value, PlayerError> {
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = mpsc::channel();
            self.pending
                .lock()
                .map_err(|_| PlayerError::Gone)?
                .insert(id, tx);
            let line = json!({"command": args, "request_id": id}).to_string();
            if self.out.send(line).is_err() {
                self.forget(id);
                return Err(PlayerError::Gone);
            }
            match rx.recv_timeout(COMMAND_TIMEOUT) {
                Ok(r) => r,
                Err(_) => {
                    self.forget(id);
                    Err(PlayerError::Gone)
                }
            }
        }

        /// Sends a command without waiting for the answer (`request_id` 0: mpv's reply is ignored).
        pub fn send(&self, args: Value) {
            let _ = self.out.send(json!({"command": args}).to_string());
        }

        fn forget(&self, id: u64) {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
        }

        /// mpv's events; taken once (later calls get a closed channel). It closes on pipe EOF.
        pub fn events(&self) -> mpsc::Receiver<MpvEvent> {
            match self.events.lock().ok().and_then(|mut e| e.take()) {
                Some(rx) => rx,
                None => mpsc::channel().1,
            }
        }
    }

    /// The pipe's server must be our mpv child, running as the current user.
    fn verify_owner(client: &NamedPipeClient, child_pid: u32) -> io::Result<()> {
        let mut server = 0u32;
        // SAFETY: a valid pipe handle owned by `client`; `server` is a valid out pointer.
        if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle() as HANDLE, &mut server) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        if server != child_pid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the pipe does not belong to the player",
            ));
        }
        // SAFETY: OpenProcess with query rights; the handle is closed below.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, server) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let theirs = token_user(process);
        // SAFETY: the handle opened above.
        unsafe { CloseHandle(process) };
        // SAFETY: the pseudo handle of this process needs no closing.
        let ours = token_user(unsafe { GetCurrentProcess() })?;
        let theirs = theirs?;
        let (a, b) = (
            theirs.as_ptr() as *const TOKEN_USER,
            ours.as_ptr() as *const TOKEN_USER,
        );
        // SAFETY: both buffers hold a TOKEN_USER (8-byte aligned) whose Sid points into the same buffer.
        let same = unsafe { EqualSid((*a).User.Sid, (*b).User.Sid) } != 0;
        if !same {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the pipe's owner is another user",
            ));
        }
        Ok(())
    }

    /// The process token's TOKEN_USER, in a u64 buffer for alignment.
    fn token_user(process: HANDLE) -> io::Result<Vec<u64>> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: a process handle with query rights; `token` is a valid out pointer.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut len = 0u32;
        // SAFETY: a size query with no buffer.
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len) };
        let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
        let size = (buf.len() * 8) as u32;
        // SAFETY: `buf` has room for `size` bytes.
        let ok = unsafe {
            GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), size, &mut len)
        };
        let err = io::Error::last_os_error();
        // SAFETY: the token opened above.
        unsafe { CloseHandle(token) };
        if ok == 0 {
            return Err(err);
        }
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lines_are_replies_or_events() {
        assert_eq!(
            classify(br#"{"request_id": 7, "error": "success", "data": [1, 2]}"#),
            Line::Reply {
                id: 7,
                result: Ok(json!([1, 2]))
            }
        );
        assert_eq!(
            classify(b"{\"request_id\":8,\"error\":\"success\"}\n"),
            Line::Reply {
                id: 8,
                result: Ok(Value::Null)
            }
        );
        assert_eq!(
            classify(br#"{"request_id": 9, "error": "property not found"}"#),
            Line::Reply {
                id: 9,
                result: Err("property not found".into())
            }
        );
        assert_eq!(
            classify(br#"{"event": "property-change", "id": 2, "name": "pause", "data": true}"#),
            Line::Event(MpvEvent::Property {
                name: "pause".into(),
                data: json!(true)
            })
        );
        assert_eq!(
            classify(br#"{"event": "client-message", "args": ["ff-action", "{\"a\":\"back\"}"]}"#),
            Line::Event(MpvEvent::Message(vec![
                "ff-action".into(),
                r#"{"a":"back"}"#.into()
            ]))
        );
        // a request id of 0 is mpv's answer to a command without one (async replies are not used)
        assert_eq!(
            classify(br#"{"request_id": 0, "error": "success"}"#),
            Line::Ignore
        );
        for junk in [
            &b""[..],
            b"\n",
            b"not json",
            b"[1,2]",
            b"{\"request_id\": \"x\"}",
            b"\xff\xfe",
        ] {
            assert_eq!(classify(junk), Line::Ignore, "{junk:?}");
        }
    }
}
