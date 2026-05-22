#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startBridge } from "./bridge.js";
import { buildMcpServer } from "./mcp.js";
import { Store } from "./store.js";

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const port = envInt("ROBLOX_MCP_PORT", 7777);
  const host = process.env.ROBLOX_MCP_HOST || "127.0.0.1";
  const authKey = process.env.ROBLOX_MCP_KEY || "";
  const pollTimeoutSec = envInt("ROBLOX_MCP_POLL_TIMEOUT", 25);
  const cmdTimeoutMs = envInt("ROBLOX_MCP_CMD_TIMEOUT_MS", 15000);
  const capacity = envInt("ROBLOX_MCP_EVENT_CAPACITY", 5000);

  const store = new Store(capacity);

  // HTTP bridge for the Roblox game (stderr-logged so MCP stdout stays clean).
  startBridge(store, { port, host, authKey, pollTimeoutSec });

  // MCP server over stdio for Claude Code.
  const mcp = buildMcpServer(store, cmdTimeoutMs);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  process.stderr.write(
    `[roblox-mcp] ready. bridge=http://${host}:${port} auth=${authKey ? "on" : "off"}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[roblox-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
