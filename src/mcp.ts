import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "./store.js";
import type { CommandKind, EventType } from "./types.js";

const EVENT_TYPES: [EventType, ...EventType[]] = [
  "movement",
  "jump",
  "click",
  "tool",
  "gui",
  "remote",
  "character",
  "object",
  "workspace",
  "log",
  "error",
  "chat",
  "custom",
  "system",
];

/** Build the MCP server exposing tools that read from / write to the Store. */
export function buildMcpServer(store: Store, defaultCmdTimeoutMs: number): McpServer {
  const server = new McpServer({
    name: "roblox-mcp",
    version: "1.0.0",
  });

  const json = (obj: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  });

  // ---- Read tools ------------------------------------------------------

  server.tool(
    "roblox_status",
    "Check whether a Roblox game is currently connected to the bridge, plus basic counters.",
    {},
    async () => json({
      connected: store.isConnected(),
      lastContactMsAgo: store.lastContact ? Date.now() - store.lastContact : null,
      latestSeq: store.latestSeq,
      hasState: store.getState() != null,
    }),
  );

  server.tool(
    "roblox_get_state",
    "Get the latest full game-state snapshot: players, positions, health, equipped tools, and metrics.",
    {},
    async () => {
      const state = store.getState();
      if (!state) return json({ error: "no state received yet; is the Roblox script running?" });
      return json(state);
    },
  );

  server.tool(
    "roblox_query_events",
    "Query recent game events with optional filters. Returns newest-last. Use this to inspect player behavior and what happened in the game.",
    {
      types: z.array(z.enum(EVENT_TYPES)).optional().describe("Filter to these event categories."),
      userId: z.number().optional().describe("Only events for this player userId."),
      afterSeq: z.number().optional().describe("Only events with seq greater than this."),
      sinceMs: z.number().optional().describe("Only events from the last N milliseconds."),
      limit: z.number().min(1).max(1000).optional().describe("Max events to return (default 100)."),
    },
    async (args) => {
      const events = store.query(args);
      return json({ count: events.length, latestSeq: store.latestSeq, events });
    },
  );

  server.tool(
    "roblox_wait_events",
    "Long-poll for NEW events after a given seq. Blocks until events arrive or timeout. Use this to follow the game live with low latency.",
    {
      afterSeq: z.number().describe("Wait for events with seq greater than this. Pass the latestSeq from a prior call."),
      timeoutMs: z.number().min(100).max(60000).optional().describe("Max time to wait (default 25000)."),
      types: z.array(z.enum(EVENT_TYPES)).optional().describe("Filter to these event categories."),
    },
    async ({ afterSeq, timeoutMs, types }) => {
      let events = await store.waitForEvents(afterSeq, timeoutMs ?? 25000);
      if (types) events = events.filter((e) => types.includes(e.type));
      return json({ count: events.length, latestSeq: store.latestSeq, events });
    },
  );

  // ---- Command tools (Claude -> game) ----------------------------------

  const dispatch = async (kind: CommandKind, args: Record<string, unknown>, wait: boolean, timeoutMs?: number) => {
    if (!store.isConnected()) {
      return json({ error: "no Roblox game connected; commands would never run" });
    }
    const cmd = store.enqueueCommand(kind, args);
    if (!wait) return json({ queued: true, commandId: cmd.id });
    const result = await store.waitForResult(cmd.id, timeoutMs ?? defaultCmdTimeoutMs);
    if (!result) return json({ commandId: cmd.id, error: "timed out waiting for game to report result" });
    return json(result);
  };

  server.tool(
    "roblox_run_luau",
    "Execute a Luau snippet on the Roblox SERVER and return its result. The snippet runs inside a function; use `return` to send a value back. Powerful: use for arbitrary inspection or mutation of the game.",
    {
      code: z.string().describe("Luau source. Example: `return #game.Players:GetPlayers()`"),
      wait: z.boolean().optional().describe("Wait for the result (default true)."),
      timeoutMs: z.number().optional().describe("Result wait timeout."),
    },
    async ({ code, wait, timeoutMs }) => dispatch("run_luau", { code }, wait ?? true, timeoutMs),
  );

  server.tool(
    "roblox_set_property",
    "Set a property on an instance addressed by a game path, e.g. path 'Workspace.Part', property 'Transparency', value 0.5.",
    {
      path: z.string().describe("Dotted path from `game`, e.g. 'Workspace.SpawnLocation'."),
      property: z.string(),
      value: z.any().describe("Number, string, boolean, or {x,y,z} for Vector3 / {r,g,b} for Color3."),
      wait: z.boolean().optional(),
    },
    async ({ path, property, value, wait }) =>
      dispatch("set_property", { path, property, value }, wait ?? true),
  );

  server.tool(
    "roblox_create_instance",
    "Create a new instance under a parent path.",
    {
      className: z.string().describe("e.g. 'Part', 'Folder', 'PointLight'."),
      parentPath: z.string().describe("Dotted path of the parent, e.g. 'Workspace'."),
      properties: z.record(z.any()).optional().describe("Initial properties to set."),
      wait: z.boolean().optional(),
    },
    async ({ className, parentPath, properties, wait }) =>
      dispatch("create_instance", { className, parentPath, properties: properties ?? {} }, wait ?? true),
  );

  server.tool(
    "roblox_destroy_instance",
    "Destroy an instance addressed by a game path.",
    {
      path: z.string(),
      wait: z.boolean().optional(),
    },
    async ({ path, wait }) => dispatch("destroy_instance", { path }, wait ?? true),
  );

  server.tool(
    "roblox_fire_remote",
    "Fire a RemoteEvent. Set toAll=true to FireAllClients, or pass a userId to FireClient, otherwise it fires server-side handling.",
    {
      path: z.string().describe("Dotted path to the RemoteEvent."),
      args: z.array(z.any()).optional(),
      toAll: z.boolean().optional(),
      userId: z.number().optional(),
      wait: z.boolean().optional(),
    },
    async ({ path, args, toAll, userId, wait }) =>
      dispatch("fire_remote", { path, args: args ?? [], toAll: !!toAll, userId }, wait ?? false),
  );

  server.tool(
    "roblox_message",
    "Send a notification message to players (rendered by the script's message handler).",
    {
      text: z.string(),
      userId: z.number().optional().describe("Target one player; omit for all."),
      wait: z.boolean().optional(),
    },
    async ({ text, userId, wait }) => dispatch("message", { text, userId }, wait ?? false),
  );

  server.tool(
    "roblox_snapshot",
    "Force the Roblox script to push a fresh state snapshot immediately, then return it.",
    {},
    async () => {
      if (!store.isConnected()) return json({ error: "no Roblox game connected" });
      const cmd = store.enqueueCommand("snapshot", {});
      await store.waitForResult(cmd.id, 5000);
      return json(store.getState() ?? { error: "no state after snapshot" });
    },
  );

  return server;
}
