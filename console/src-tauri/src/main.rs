// SPDX-License-Identifier: GPL-3.0-or-later
// NonZeroScript - native console (Tauri 2).
//
// Thin by design: the window shows the embedded console UI (console/ui), and
// the Python relay (controller.exe) runs beside the exe as a child process
// serving http://127.0.0.1:8790. Closing the console stops the relay.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static RELAY: Mutex<Option<Child>> = Mutex::new(None);

fn spawn_relay() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    let relay = dir.join("controller.exe");
    if !relay.exists() {
        return;
    }
    if let Ok(child) = Command::new(&relay)
        .arg("--no-open")
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
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
