#!/usr/bin/env node
// One-command installer for the Roblox MCP — Node only, no Python required.
//
//   npm run setup                  build + register into Claude Code (user scope)
//   node scripts/setup.mjs --port 7777 --name roblox --key ""
//   node scripts/setup.mjs --skip-build
//   node scripts/setup.mjs --uninstall
//
// It (1) installs deps + compiles TS, then (2) registers the server with
// Claude Code, preferring the `claude mcp add-json` CLI and falling back to
// editing ~/.claude.json directly. The Claude config is backed up before edits.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ENTRY = join(ROOT, "dist", "index.js");
const IS_WIN = process.platform === "win32";

const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const info = (m) => console.log(c(36, "[setup]"), m);
const ok = (m) => console.log(c(32, "[ ok ]"), m);
const warn = (m) => console.log(c(33, "[warn]"), m);
const die = (m) => { console.error(c(31, "[fail]"), m); process.exit(1); };

function parseArgs(argv) {
  const a = { name: "roblox", port: 7777, key: "", skipBuild: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--name") a.name = argv[++i];
    else if (k === "--port") a.port = parseInt(argv[++i], 10);
    else if (k === "--key") a.key = argv[++i] ?? "";
    else if (k === "--skip-build") a.skipBuild = true;
    else if (k === "--uninstall") a.uninstall = true;
    else die(`unknown argument: ${k}`);
  }
  return a;
}

// Run a command, inheriting stdio. shell:true on Windows so npm/claude .cmd shims resolve.
function run(cmd, args) {
  info("$ " + [cmd, ...args].join(" "));
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: IS_WIN });
  if (r.status !== 0) die(`command failed (exit ${r.status}): ${cmd}`);
}

function tryCmd(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: IS_WIN });
  return { status: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function hasCommand(cmd) {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8", shell: IS_WIN });
  return !r.error && r.status === 0;
}

function build() {
  info("Installing dependencies…");
  run("npm", ["install"]);
  info("Compiling TypeScript…");
  run("npm", ["run", "build"]);
  if (!existsSync(DIST_ENTRY)) die(`build did not produce ${DIST_ENTRY}`);
  ok(`built ${DIST_ENTRY}`);
}

function serverConfig(port, key) {
  return {
    command: "node",
    args: [DIST_ENTRY],
    env: { ROBLOX_MCP_PORT: String(port), ROBLOX_MCP_KEY: key },
  };
}

const claudeConfigPath = () => join(homedir(), ".claude.json");

function registerViaCli(name, cfg) {
  if (!hasCommand("claude")) return false;
  info("Registering via the `claude` CLI (user scope)…");
  // Idempotent: drop any prior entry first (ignore failure if absent).
  tryCmd("claude", ["mcp", "remove", name, "--scope", "user"]);
  const r = tryCmd("claude", ["mcp", "add-json", name, JSON.stringify(cfg), "--scope", "user"]);
  if (r.status !== 0) {
    warn(`\`claude mcp add-json\` failed: ${r.out.trim()}`);
    return false;
  }
  ok(`registered '${name}' via claude CLI`);
  return true;
}

function registerViaFile(name, cfg) {
  const path = claudeConfigPath();
  info(`Registering by editing ${path} …`);
  let data = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8") || "{}");
    } catch {
      die(`${path} is not valid JSON; fix or remove it and re-run.`);
    }
    copyFileSync(path, path + ".bak");
    ok(`backed up existing config to ${path}.bak`);
  }
  data.mcpServers = data.mcpServers || {};
  data.mcpServers[name] = cfg;
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  ok(`wrote '${name}' into ${path}`);
}

function uninstall(name) {
  if (hasCommand("claude")) {
    tryCmd("claude", ["mcp", "remove", name, "--scope", "user"]);
  }
  const path = claudeConfigPath();
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8") || "{}");
      if (data.mcpServers && data.mcpServers[name]) {
        delete data.mcpServers[name];
        writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
        ok(`removed '${name}' from ${path}`);
      }
    } catch { /* ignore */ }
  }
  ok("uninstalled");
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.uninstall) return uninstall(args.name);

  if (!hasCommand("node")) die("Node.js not found (>= 18). Install from https://nodejs.org");
  if (!args.skipBuild) build();
  else if (!existsSync(DIST_ENTRY)) die(`${DIST_ENTRY} missing; run without --skip-build first.`);

  const cfg = serverConfig(args.port, args.key);
  if (!registerViaCli(args.name, cfg)) registerViaFile(args.name, cfg);

  console.log();
  ok("Done. Next steps:");
  console.log(`  1. Restart Claude Code so it loads the '${args.name}' MCP server.`);
  console.log(`  2. Run /mcp in Claude Code and confirm '${args.name}' is listed.`);
  console.log("  3. In Roblox: enable Allow HTTP Requests, paste roblox/MCPBridge.server.lua");
  console.log("     into a Script in ServerScriptService (or run it via your executor), press Play.");
  console.log(`  4. Open the dashboard at http://127.0.0.1:${args.port}/ and press Connect.`);
  if (args.key) warn(`You set a key; put the SAME value in CONFIG.AuthKey inside the Lua script.`);
}

main();
