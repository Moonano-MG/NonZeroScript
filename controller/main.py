#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""NonZeroScript controller - local relay + console server.

Shipped as controller.exe (PyInstaller one-file, Windows 10/11 64-bit): the
relay that runs beside the native console (NonZeroScript.exe, Tauri 2), which
starts it with --no-open and shows the UI itself. From source:

    python main.py                 # 127.0.0.1:8790, opens the console page
    python main.py --host 0.0.0.0  # only for a sandbox/remote demo
    python main.py --port 9000 --no-open

No third-party packages. Python 3.9+.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

try:
    from .hub import Hub
    from .server import create_server
    from .settings import Settings
    from .version import __version__
except ImportError:
    from hub import Hub
    from server import create_server
    from settings import Settings
    from version import __version__

# Bundled resources (ui/, tools.json). Under PyInstaller these live in the
# temporary extraction dir (_MEIPASS); the data folder must NOT live there.
# A windowed run (the native console spawns this relay with file/null std
# streams) gets locale text streams - cp1252 on an English Windows - and the
# banner below is full of CJK. Without this, the very first print() raises
# UnicodeEncodeError and the relay dies before it ever binds a port.
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None:
        try:
            _stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass

BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
BANNER = r"""
  _  _             ____                 ____            _       _
 | \| | ___  _ _  |__  |___ _ _ ___ ___/ ___|  ___ _ __(_)_ __ | |_
 | .` |/ _ \| ' \   / /|  _| '_/ _ \___\___ \ / __| '__| | '_ \| __|
 |_|\_|\___/|_||_| /_/ |_| |_| \___/   |____/ \___|_|  |_| .__/ \__|
                                                         |_|
  Godot 4.7.2 edition · ZeroScript 官方衍生版 · v%s
"""


def free_port_warning(host: str, port: int) -> bool:
    """True when the port is available."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="NonZeroScript controller (Godot edition)")
    ap.add_argument("--host", default=None, help="bind address (default from settings: 127.0.0.1)")
    ap.add_argument("--port", type=int, default=None, help="port (default from settings: 8790)")
    ap.add_argument("--data", default=str(APP_DIR / "data"), help="data folder for settings and memory")
    ap.add_argument("--no-open", action="store_true", help="do not open the console in a browser")
    ap.add_argument("--version", action="version", version=f"NonZeroScript {__version__}")
    args = ap.parse_args(argv)

    data_dir = Path(args.data).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    settings = Settings(data_dir)

    patch: dict[str, object] = {}
    if args.host:
        patch["host"] = "0.0.0.0" if args.host == "0.0.0.0" else "127.0.0.1"
    if args.port:
        patch["port"] = args.port
    if patch:
        settings.update(patch)

    host = str(settings.get("host"))
    port = int(settings.get("port"))

    print(BANNER % __version__)
    print(f"  Controller : http://{'127.0.0.1' if host == '127.0.0.1' else host}:{port}/")
    print(f"  Data       : {data_dir}")
    print(f"  Godot      : connect the plugin to the URL above")
    print("  Stop       : Ctrl+C (or close this window)\n")

    if not free_port_warning(host, port):
        print(f"[!] Port {port} is already in use. Close the other NonZeroScript controller,")
        print(f"    or start with: python main.py --port {port + 1}")
        return 2

    hub = Hub(settings, data_dir)
    ui_dir = BASE / "ui"
    if not (ui_dir / "index.html").exists():
        # Source checkout: the console UI lives in console/ui. It is embedded
        # into NonZeroScript.exe by Tauri and kept here for the browser
        # fallback served by this relay.
        ui_dir = BASE.parent / "console" / "ui"
    server = create_server(hub, ui_dir, host, port)
    url = f"http://{'127.0.0.1' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}/"

    if settings.get("auto_open_console") and not args.no_open:
        def _open() -> None:
            time.sleep(0.9)
            try:
                webbrowser.open(url)
            except Exception:
                pass

        threading.Thread(target=_open, daemon=True).start()

    hub.log("controller", f"中转已启动 v{__version__} · http://{host}:{port}/")
    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\n  Shutting down…")
    finally:
        hub.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
