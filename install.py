#!/usr/bin/env python3
"""
One-command installer for the Roblox MCP integration.

Run from anywhere:

    python install.py                # build + register at user scope (global)
    python install.py --scope project  # also write a project-local .mcp.json
    python install.py --name roblox --port 7777 --key ""
    python install.py --uninstall    # remove the registration

It will:
  1. Check that Node.js and npm are available.
  2. Install dependencies and compile the TypeScript (npm install + build).
  3. Register the server with Claude Code:
       - preferred: `claude mcp add-json` (the supported CLI)
       - fallback:  edit ~/.claude.json directly (no CLI needed)

Designed to be safe to publish on GitHub: paths are resolved relative to this
file, and the Claude config is backed up before editing.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST_ENTRY = ROOT / "dist" / "index.js"


def info(msg: str) -> None:
    print(f"\033[36m[install]\033[0m {msg}")


def ok(msg: str) -> None:
    print(f"\033[32m[ ok ]\033[0m {msg}")


def warn(msg: str) -> None:
    print(f"\033[33m[warn]\033[0m {msg}")


def die(msg: str) -> None:
    print(f"\033[31m[fail]\033[0m {msg}", file=sys.stderr)
    sys.exit(1)


def which(name: str) -> str | None:
    # On Windows npm/claude are .cmd shims; shutil.which handles PATHEXT.
    return shutil.which(name)


def run(cmd: list[str], cwd: Path | None = None) -> None:
    info("$ " + " ".join(cmd))
    # shell=True on Windows so .cmd shims (npm, claude) resolve correctly.
    result = subprocess.run(cmd, cwd=str(cwd) if cwd else None, shell=(os.name == "nt"))
    if result.returncode != 0:
        die(f"command failed with exit code {result.returncode}")


def check_prereqs() -> None:
    if which("node") is None:
        die("Node.js not found. Install it from https://nodejs.org (>= 18).")
    if which("npm") is None:
        die("npm not found. It ships with Node.js.")
    node_ver = subprocess.run(
        ["node", "-v"], capture_output=True, text=True, shell=(os.name == "nt")
    ).stdout.strip()
    ok(f"node {node_ver}")


def build() -> None:
    info("Installing dependencies...")
    run(["npm", "install"], cwd=ROOT)
    info("Compiling TypeScript...")
    run(["npm", "run", "build"], cwd=ROOT)
    if not DIST_ENTRY.exists():
        die(f"build did not produce {DIST_ENTRY}")
    ok(f"built {DIST_ENTRY}")


def server_config(port: int, key: str) -> dict:
    return {
        "command": "node",
        "args": [str(DIST_ENTRY)],
        "env": {
            "ROBLOX_MCP_PORT": str(port),
            "ROBLOX_MCP_KEY": key,
        },
    }


def claude_config_path() -> Path:
    # Claude Code stores user-scoped settings (incl. mcpServers) in ~/.claude.json.
    return Path.home() / ".claude.json"


def register_via_cli(name: str, cfg: dict) -> bool:
    if which("claude") is None:
        return False
    info("Registering via the `claude` CLI (user scope)...")
    # Remove any prior entry so this is idempotent (ignore failure if absent).
    subprocess.run(
        ["claude", "mcp", "remove", name, "--scope", "user"],
        capture_output=True,
        shell=(os.name == "nt"),
    )
    payload = json.dumps(cfg)
    result = subprocess.run(
        ["claude", "mcp", "add-json", name, payload, "--scope", "user"],
        capture_output=True,
        text=True,
        shell=(os.name == "nt"),
    )
    if result.returncode != 0:
        warn(f"`claude mcp add-json` failed: {result.stderr.strip() or result.stdout.strip()}")
        return False
    ok(f"registered '{name}' via claude CLI")
    return True


def register_via_file(name: str, cfg: dict) -> None:
    path = claude_config_path()
    info(f"Registering by editing {path} ...")
    data: dict = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            die(f"{path} is not valid JSON; fix or remove it and re-run.")
        backup = path.with_suffix(".json.bak")
        shutil.copy2(path, backup)
        ok(f"backed up existing config to {backup}")
    servers = data.setdefault("mcpServers", {})
    servers[name] = cfg
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    ok(f"wrote '{name}' into {path}")


def write_project_config(name: str, cfg: dict) -> None:
    path = ROOT / ".mcp.json"
    data: dict = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            data = {}
    data.setdefault("mcpServers", {})[name] = cfg
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    ok(f"wrote project-scoped {path}")


def uninstall(name: str) -> None:
    if which("claude") is not None:
        subprocess.run(
            ["claude", "mcp", "remove", name, "--scope", "user"],
            shell=(os.name == "nt"),
        )
    path = claude_config_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8") or "{}")
            if name in data.get("mcpServers", {}):
                del data["mcpServers"][name]
                path.write_text(json.dumps(data, indent=2), encoding="utf-8")
                ok(f"removed '{name}' from {path}")
        except json.JSONDecodeError:
            pass
    ok("uninstalled")


def main() -> None:
    ap = argparse.ArgumentParser(description="Install the Roblox MCP into Claude Code.")
    ap.add_argument("--name", default="roblox", help="MCP server name (default: roblox)")
    ap.add_argument("--port", type=int, default=7777, help="Bridge HTTP port (default: 7777)")
    ap.add_argument("--key", default="", help="Shared secret; must match the Lua CONFIG.AuthKey")
    ap.add_argument("--scope", choices=["user", "project"], default="user",
                    help="user = global (default); project = also write ./.mcp.json")
    ap.add_argument("--skip-build", action="store_true", help="Don't run npm install/build")
    ap.add_argument("--uninstall", action="store_true", help="Remove the registration and exit")
    args = ap.parse_args()

    if args.uninstall:
        uninstall(args.name)
        return

    check_prereqs()
    if not args.skip_build:
        build()
    elif not DIST_ENTRY.exists():
        die(f"{DIST_ENTRY} missing; run without --skip-build first.")

    cfg = server_config(args.port, args.key)

    if args.scope == "project":
        write_project_config(args.name, cfg)

    # Always register at user scope so the server works from any directory.
    if not register_via_cli(args.name, cfg):
        register_via_file(args.name, cfg)

    print()
    ok("Done. Next steps:")
    print("  1. Restart Claude Code (so it loads the new MCP server).")
    print(f"  2. In Claude Code run /mcp and confirm '{args.name}' is listed.")
    print("  3. In Roblox Studio: enable Allow HTTP Requests, paste")
    print("     roblox/MCPBridge.server.lua into a Script in ServerScriptService, press Play.")
    print(f"  4. Open the dashboard at http://127.0.0.1:{args.port}/ and press Connect,")
    print("     or ask Claude to run roblox_status — it should report connected: true.")
    if args.key:
        warn(f"You set a key; put the SAME value in CONFIG.AuthKey inside the Lua script.")


if __name__ == "__main__":
    main()
