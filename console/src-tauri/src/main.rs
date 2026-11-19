// SPDX-License-Identifier: GPL-3.0-or-later
// NonZeroScript - native console (Tauri 2).
//
// Thin by design: the window shows the embedded console UI (console/ui), and
// the Python relay (controller.exe) runs beside the exe as a child process
// serving http://127.0.0.1:8790. Closing the console stops the relay. The
// relay's stdout/stderr go to data/relay.log next to the exe.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static RELAY: Mutex<Option<Child>> = Mutex::new(None);

fn spawn_relay() {
    let exe = match std::env::current_exe() {
        Ok(v) => v,
        Err(_) => return,
    };
    // Windows hands out verbatim (\\?\) paths; CreateProcess accepts such a
    // program path but rejects it as the working directory, so strip the
    // prefix before using it.
    let shown = exe.display().to_string();
    let stripped = shown.strip_prefix("\\\\?\\").unwrap_or(&shown).to_string();
    let path = PathBuf::from(&stripped);
    let dir = match path.parent() {
        Some(v) => v.to_path_buf(),
        None => return,
    };
    let relay = dir.join("controller.exe");
    if !relay.exists() {
        return;
    }
    let log_dir = dir.join("data");
    let _ = fs::create_dir_all(&log_dir);
    let mut cmd = Command::new(&relay);
    cmd.arg("--no-open");
    // The console webview (CSP + UI base) and the extension default all point
    // at 8790 - pin the relay to it so a stale data/settings.json port can
    // never split the console from its own relay.
    cmd.arg("--port").arg("8790");
    cmd.current_dir(&dir);
    cmd.stdin(Stdio::null());
    match fs::File::create(log_dir.join("relay.log")) {
        Ok(file) => {
            let err = file.try_clone();
            cmd.stdout(Stdio::from(file));
            match err {
                Ok(err) => {
                    cmd.stderr(Stdio::from(err));
                }
                Err(_) => {
                    cmd.stderr(Stdio::null());
                }
            }
        }
        Err(_) => {
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
        }
    }
    if let Ok(child) = cmd.spawn() {
        if let Ok(mut slot) = RELAY.lock() {
            *slot = Some(child);
        }
    }
}

fn kill_relay() {
    if let Ok(mut slot) = RELAY.lock() {
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *slot = None;
    }
}

fn main() {
    spawn_relay();
    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("failed to build the NonZeroScript console");
    app.run(|_handle, event| {
        if let tauri::RunEvent::Exit = event {
            kill_relay();
        }
    });
}
