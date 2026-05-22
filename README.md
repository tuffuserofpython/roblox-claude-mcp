# Roblox MCP — live game integration for Claude Code

Stream everything happening inside a Roblox game to Claude Code in real time, let
Claude inspect and drive the game back, and watch it all in a clean web dashboard.
**One** Roblox script talks to a small local Node bridge that doubles as an MCP
server and serves the dashboard.

```
 Roblox                          Node process (this repo)              Claude Code
┌──────────────────┐   HTTP    ┌──────────────────────────────┐  stdio  ┌──────────┐
│ MCPBridge.server │ ───────▶  │  HTTP bridge ── Store ──      │ ◀─────▶ │  Claude  │
│   .lua (1 script)│ ◀───────  │            MCP server         │         └──────────┘
└──────────────────┘  poll     │                              │
   POST /events                │   Dashboard  ◀── browser     │
   POST /state                 └──────────────────────────────┘
   GET  /poll  (long-poll)        buffers events + game state
```

Why this shape: Roblox `HttpService` can only make **outbound** requests, so the
game pushes events and **long-polls** for commands. Long-polling keeps command
latency low — commands are delivered the instant they are queued.

## What gets captured

The goal is to capture as much of what happens in the game as Roblox allows.

| What                       | Captured by                                     | Side    |
| -------------------------- | ----------------------------------------------- | ------- |
| Player movement            | per-player position sampler (threshold-based)   | server  |
| Jumping                    | `Humanoid.Jumping`                              | server  |
| Clicking / interactions    | `ClickDetector.MouseClick`; world clicks        | server / client\* |
| **Which script handles a click** | `getconnections` + `debug.info`           | executor only |
| Tool usage                 | `Tool.Equipped/Unequipped/Activated`            | server  |
| GUI interactions           | `GuiButton.Activated`                           | client\* |
| Remote events/functions    | wrapped `OnServerEvent` / `OnServerInvoke`      | server  |
| Character state changes     | `StateChanged`, `HealthChanged`, `Died`        | server  |
| Object creation/destroy    | `DescendantAdded` / `DescendantRemoving`        | server  |
| **All script output**      | `LogService.MessageOut` (every print/warn/error)| server  |
| **Runtime errors**         | `ScriptContext.Error` (message + traceback + script) | server |
| **Chat messages**          | `Player.Chatted`                                | server  |
| Custom game events         | `_G.MCP.emit(...)` or `MCPCustomEvent` Bindable | server  |

\* See **GUI & raw input** below — these are client-only signals on Roblox.

`LogService.MessageOut` is the closest thing to "see what every script is doing"
without a debugger: it streams every line any script prints, warns, or errors.

## Quick install (recommended)

One command builds everything and registers the server with Claude Code at user
scope (works from any directory). Requires **Node.js >= 18**.

```bash
npm run setup
```

Options:

```bash
node scripts/setup.mjs --port 7777 --key "my-secret"
node scripts/setup.mjs --skip-build      # register without rebuilding
npm run uninstall                        # remove the registration
```

It checks Node, runs `npm install` + `npm run build`, then registers via the
`claude` CLI (falling back to editing `~/.claude.json`, backed up first). After it
finishes, **restart Claude Code** and run `/mcp` to confirm `roblox` is listed.

> Prefer Python? `python install.py` does the same thing and supports
> `--scope project` to also write a project-local `./.mcp.json`.

Then jump to [the Roblox side](#3-install-the-roblox-script).

## The dashboard

The bridge serves a clean dashboard at **http://127.0.0.1:7777/**.

- A **Connect / Disconnect** button — this only controls the *page's* live link to
  the bridge (it starts/stops polling). It does not touch the game.
- A status **dot** (green = a game is currently connected to the bridge).
- The **avatar and username** of the user running the bridge (under an executor,
  that is the executing player; on a real server there is none).
- A live **MOST RECENT EVENTS** feed, newest first.

Open it in any browser while the Node server is running and press **Connect**.

## Manual setup

### 1. Build the Node bridge / MCP server

```bash
npm install
npm run build
```

### 2. Register it with Claude Code

Copy `.mcp.json.example` to `.mcp.json` (project scope) or add the same block to
your user config, then restart Claude Code. Or use the CLI:

```bash
claude mcp add roblox -- node /absolute/path/to/dist/index.js
```

The MCP server starts the HTTP bridge automatically on `127.0.0.1:7777`.

### 3. Install the Roblox script

1. Enable **Game Settings → Security → Allow HTTP Requests**.
2. (Optional, for `roblox_run_luau`) Select **ServerScriptService** and tick
   **LoadStringEnabled**.
3. Insert a **Script** into **ServerScriptService** and paste the contents of
   [`roblox/MCPBridge.server.lua`](roblox/MCPBridge.server.lua). (Running it via an
   executor also works and unlocks click-handler resolution.)
4. Edit the `CONFIG` block at the top if needed (`ApiUrl`, `AuthKey`, capture toggles).
5. Press **Play**. You should see `[MCPBridge] running...` in the Output, and
   `roblox_status` in Claude will report `connected: true`.

## Configuration

Node side (env vars, set in `.mcp.json`):

| Var                         | Default     | Meaning                                  |
| --------------------------- | ----------- | ---------------------------------------- |
| `ROBLOX_MCP_PORT`           | `7777`      | Bridge HTTP port (and dashboard)         |
| `ROBLOX_MCP_HOST`           | `127.0.0.1` | Bind address                             |
| `ROBLOX_MCP_KEY`            | `""`        | Shared secret; must match Lua `AuthKey`  |
| `ROBLOX_MCP_POLL_TIMEOUT`   | `25`        | Long-poll hold time (seconds)            |
| `ROBLOX_MCP_CMD_TIMEOUT_MS` | `15000`     | How long tools wait for a command result |
| `ROBLOX_MCP_EVENT_CAPACITY` | `5000`      | Ring-buffer size                         |

The Lua `CONFIG` block also has capture toggles (`CaptureLogs`, `CaptureErrors`,
`CaptureChat`, `CaptureClickHandlers`, …). If you set a key on the Node side, set
the same value in the Lua `CONFIG.AuthKey`.

## MCP tools exposed to Claude

**Read**
- `roblox_status` — is a game connected, counters.
- `roblox_get_state` — players, positions, health, tools, metrics, executor identity.
- `roblox_query_events` — filter recent events by type/player/time/seq.
- `roblox_wait_events` — long-poll for new events (live following, low latency).

**Act**
- `roblox_run_luau` — run a Luau snippet on the server and return the result.
- `roblox_set_property` — set a property on an instance by path.
- `roblox_create_instance` / `roblox_destroy_instance`.
- `roblox_fire_remote` — FireAllClients / FireClient / Bindable fire.
- `roblox_message` — notify players.
- `roblox_snapshot` — force a fresh state push and return it.

Paths are dotted from `game`, e.g. `Workspace.SpawnLocation`. Vectors are
`{ "x": 0, "y": 10, "z": 0 }`; colors are `{ "r": 1, "g": 0, "b": 0 }`.

## Custom events from your own game code

```lua
_G.MCP.emit("RoundStarted", { map = "Arena", players = 8 })
-- or, decoupled:
game.ServerStorage.MCPCustomEvent:Fire("RoundStarted", { map = "Arena" })
```

These arrive to Claude as `type: "custom"` events.

## Resolving which script handles a click (executor only)

In a normal game there is **no** Roblox API to tell which script ran in response
to an input — scripts run in isolated threads with no global execution hook. The
most you can do is correlate a click with the `remote` events that follow it.

Under an **executor**, the script uses `getconnections()` on the clicked signal
(`ClickDetector.MouseClick`, `GuiButton.Activated`) and `debug.info()` on each
connected function to report the **script and line** that handle it. The result
rides along in the event's `data.handlers`. In a vanilla game this field is simply
absent and everything else keeps working.

## GUI & raw input (the one-script caveat)

GUI button clicks and raw keyboard/mouse input only exist on the **client** in
Roblox — a server script cannot observe them directly, and cannot inject working
client code at runtime (`LocalScript.Source` is plugin-security protected). The
single installed script handles this two ways:

1. It auto-creates `ReplicatedStorage.MCPClientRemote`. From your own client code,
   one line reports a GUI/input event with no extra install:
   ```lua
   game.ReplicatedStorage.MCPClientRemote:FireServer("gui", { action = "Buy", button = "ShopButton" })
   ```
   The server relays it to Claude as a `gui`/`click` event.
2. `CONFIG.InjectClientCollector` attempts to spawn a client collector
   automatically. This succeeds only in privileged/executor/Studio contexts; where
   it isn't allowed it safely no-ops. All server-side capture is unaffected.

## Quick verification

With the Node server running you can mimic the game with curl:

```bash
curl -s -X POST http://127.0.0.1:7777/events -H 'content-type: application/json' \
  -d '[{"type":"jump","action":"Jumping","gameTime":1.2,"userId":1,"playerName":"Tester"}]'
curl -s http://127.0.0.1:7777/health
curl -s http://127.0.0.1:7777/api/events?afterSeq=0
```

Then open the dashboard at http://127.0.0.1:7777/ and press **Connect**, or ask
Claude to run `roblox_query_events`.

## Project layout

```
src/
  index.ts       entry: starts the bridge + MCP server
  bridge.ts      HTTP server (Roblox endpoints + dashboard + /api/*)
  mcp.ts         MCP tools exposed to Claude
  store.ts       in-memory event ring buffer, state, command queue
  dashboard.ts   the self-contained dashboard page
  types.ts       shared types (keep EventType in sync with the Lua side)
roblox/
  MCPBridge.server.lua   the single script to drop into the game
scripts/
  setup.mjs      Node installer (npm run setup)
install.py       Python installer (alternative)
```
