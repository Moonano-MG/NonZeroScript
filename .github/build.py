#!/usr/bin/env python3
"""Build the NonZeroScript download packages.

Run by .github/workflows/build.yml, and runnable by hand:

    python .github/build.py --check    # verify versions and adapter catalogues
    python .github/build.py --out out  # stage extension/ and addons/ folders

The Windows programs are built in .github/workflows/build.yml (windows-latest):
NonZeroScript.exe is the native console (Tauri 2, from console/) and
controller.exe is its relay (PyInstaller). GitHub wraps every artifact in a
zip on download, so the staging output is plain folders - no archives are
made here.

Standard library only; no pip install, no other build tool.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Files that must all carry the same version as version.txt.
# extension/manifest.json is checked separately: Chrome only accepts numbers in
# "version", so the real string (e.g. v0.1.0-dev) lives in "version_name".
VERSION_SOURCES = [
    ("controller/version.py", r'__version__\s*=\s*"([^"]+)"'),
    ("editor/godot-4.7.2/adapter.json", r'"version"\s*:\s*"([^"]+)"'),
    ("editor/godot-4.7.2/plugin.cfg", r'^version\s*=\s*"([^"]+)"'),
    ("editor/godot-4.7.2/core/commands.gd", r'const VERSION\s*:=\s*"([^"]+)"'),
    ("editor/godot-4.7.2/core/bridge.gd", r'const PLUGIN_VERSION\s*:=\s*"([^"]+)"'),
]


def manifest_numeric(version: str) -> str:
    """Chrome's plain-number form of the version: v0.1.0-dev -> 0.1.0."""
    v = version[1:] if version.startswith("v") else version
    return v.split("-", 1)[0]

SKIP_DIRS = {".git", ".github", "dist", "data", "__pycache__", "node_modules", ".godot", ".import"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".tmp", ".zip", ".log", ".uid"}


def read_version() -> str:
    text = (ROOT / "version.txt").read_text(encoding="utf-8").strip()
    return text or "0.0.0"


# --------------------------------------------------------------------------- checks


def check_versions() -> list[str]:
    expected = read_version()
    problems: list[str] = []
    if expected == "0.0.0":
        problems.append("version.txt is missing or empty")
    for rel, pattern in VERSION_SOURCES:
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            problems.append(f"{rel}: file is missing")
            continue
        match = re.search(pattern, text, re.MULTILINE)
        if not match:
            problems.append(f"{rel}: no version string found")
        elif match.group(1) != expected:
            problems.append(f"{rel}: {match.group(1)} != {expected}")
    try:
        manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        problems.append(f"extension/manifest.json: {exc}")
    else:
        if manifest.get("version_name") != expected:
            problems.append(f"extension/manifest.json: version_name {manifest.get('version_name')!r} != {expected}")
        if manifest.get("version") != manifest_numeric(expected):
            problems.append(f"extension/manifest.json: version {manifest.get('version')!r} != {manifest_numeric(expected)}")
    # The Tauri console carries the version in semver form, without the "v".
    plain = expected[1:] if expected.startswith("v") else expected
    try:
        conf = json.loads((ROOT / "console" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        problems.append(f"console/src-tauri/tauri.conf.json: {exc}")
    else:
        if str(conf.get("version")) != plain:
            problems.append(f"console/src-tauri/tauri.conf.json: version {conf.get('version')!r} != {plain}")
    try:
        cargo = (ROOT / "console" / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    except OSError as exc:
        problems.append(f"console/src-tauri/Cargo.toml: {exc}")
    else:
        match = re.search(r'(?m)^version = "([^"]+)"', cargo)
        if not match:
            problems.append("console/src-tauri/Cargo.toml: no package version found")
        elif match.group(1) != plain:
            problems.append(f"console/src-tauri/Cargo.toml: version {match.group(1)} != {plain}")
    return problems


def check_adapter() -> list[str]:
    """Every editor adapter ships adapter.json: its instructions and command
    catalogue must be complete and must match core/commands.gd exactly."""
    problems: list[str] = []
    for folder in editor_folders():
        meta_path = folder / "adapter.json"
        cmd_path = folder / "core" / "commands.gd"
        rel = str(meta_path.relative_to(ROOT))
        if not meta_path.exists():
            problems.append(f"{rel}: missing (every adapter carries its own instructions and catalogue)")
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            problems.append(f"{rel}: {exc}")
            continue
        for field in ("id", "name", "instructions"):
            if not str(meta.get(field) or "").strip():
                problems.append(f"{rel}: empty '{field}'")
        tools = meta.get("tools")
        if not isinstance(tools, list) or not tools:
            problems.append(f"{rel}: no tools")
            continue
        names: list[str] = []
        for tool in tools:
            name = str((tool or {}).get("name") or "")
            if not name:
                problems.append(f"{rel}: a tool has no name")
                continue
            names.append(name)
            if not str((tool or {}).get("description") or "").strip():
                problems.append(f"{rel}: `{name}` has no description")
            if not isinstance((tool or {}).get("params"), dict):
                problems.append(f"{rel}: `{name}` has no params object")
        if not cmd_path.exists():
            problems.append(f"{cmd_path.relative_to(ROOT)}: missing")
            continue
        text = cmd_path.read_text(encoding="utf-8")
        region = text.split("func execute", 1)[-1].split("func _ok", 1)[0]
        dispatch = set(re.findall(r'^\t\t"([a-z_]+)":\s*$', region, re.M))
        only_gd = dispatch - set(names)
        only_json = set(names) - dispatch
        if only_gd:
            problems.append(f"{rel}: commands.gd dispatches {sorted(only_gd)} but the catalogue does not list them")
        if only_json:
            problems.append(f"{rel}: the catalogue lists {sorted(only_json)} but commands.gd does not dispatch them")
    return problems


# --------------------------------------------------------------------------- build


def iter_files(base: Path, skip_top: tuple[str, ...] = ()):
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(base)
        if rel.parts[0] in SKIP_DIRS or rel.parts[0] in skip_top:
            continue
        if rel.name.startswith(".") or rel.name == "build.json":
            continue
        if any(part in SKIP_DIRS for part in rel.parts[1:]):
            continue
        if path.suffix in SKIP_SUFFIXES:
            continue
        yield rel


def copy_tree(src: Path, dst: Path, skip_top: tuple[str, ...] = ()) -> int:
    count = 0
    for rel in iter_files(src, skip_top):
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / rel, target)
        count += 1
    return count


def editor_folders() -> list[Path]:
    base = ROOT / "editor"
    return sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))


def editor_target(folder: Path) -> str:
    """Where the adapter installs inside a project (build.json may override)."""
    meta = folder / "build.json"
    if meta.exists():
        try:
            loaded = json.loads(meta.read_text(encoding="utf-8"))
            target = loaded.get("target")
            if isinstance(target, str) and target.strip():
                return target.strip().strip("/")
        except (OSError, ValueError):
            pass
    return "addons/nonzeroscript"


def stage(out: Path) -> int:
    """Lay out the download folders. GitHub zips each artifact on upload, so
    nothing here is archived - the folders themselves are the products:

      browser/extension/            the finished Chrome + Edge extension
      editor/addons/<name>/         the Godot plugin (standard GDScript)
      app/ is completed in CI       NonZeroScript.exe (Tauri console) and its
                                    controller.exe relay are built in the
                                    workflow and dropped next to the LICENSE

    LICENSE is copied next to each product (GPL) and, as the only file beside a
    single folder, it also keeps that folder at the artifact root.
    """
    version = read_version()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    print(f"\nNonZeroScript {version} — staging download folders\n")

    ext = out / "browser" / "extension"
    n = copy_tree(ROOT / "extension", ext)
    shutil.copy2(ROOT / "LICENSE", out / "browser" / "LICENSE")
    print(f"  [ok] extension/              {n} files  (Chrome + Edge, load unpacked)")

    for folder in editor_folders():
        target = editor_target(folder)
        n = copy_tree(folder, out / "editor" / target, skip_top=("build.json",))
        shutil.copy2(ROOT / "LICENSE", out / "editor" / "LICENSE")
        print(f"  [ok] {target:<22} {n} files  (standard GDScript addon)")

    (out / "app").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "LICENSE", out / "app" / "LICENSE")
    print("  [ ] NonZeroScript.exe        native console, built by Tauri in the workflow")
    print("  [ ] controller.exe           relay, built by PyInstaller in the workflow")
    print()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build NonZeroScript outputs")
    ap.add_argument("--check", action="store_true", help="verify versions and adapter catalogues, write nothing")
    ap.add_argument("--out", default="out", help="staging folder (default: out/)")
    args = ap.parse_args(argv)

    problems = check_versions() + check_adapter()
    if args.check or problems:
        for problem in problems:
            print(f"FAIL {problem}")
        if problems:
            print(f"\n{len(problems)} problem(s).")
            return 1
        if args.check:
            print(f"OK NonZeroScript {read_version()}: versions and adapter catalogues are consistent")
        return 0

    return stage(Path(args.out) if Path(args.out).is_absolute() else ROOT / args.out)


if __name__ == "__main__":
    sys.exit(main())
